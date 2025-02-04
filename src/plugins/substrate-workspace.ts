import {CargoWorkspace, CrateInfo} from './cargo-workspace';
import {CandidateReleasePullRequest, ROOT_PROJECT_PATH} from '../manifest';
import {VersionsMap} from '../version';
import {RawContent} from '../updaters/raw-content';
import {RemoveFile} from '../updaters/remove-file';
import {CompositeUpdater} from '../updaters/composite';
import {
  CargoTomlRemovePaths,
  CargoWorkspaceMembers,
} from '../updaters/rust/cargo-toml';
import {ReleasePleaseManifest} from '../updaters/release-please-manifest';
import {Merge} from './merge';
import {Update, Encoding} from '../update';
import {FileNotFoundError} from '../errors';
import {isUtf8} from 'node:buffer';

interface FileContent {
  content: string;
  encoding: Encoding;
}

export class SubstrateWorkspace extends CargoWorkspace {
  async run(
    candidates: CandidateReleasePullRequest[]
  ): Promise<CandidateReleasePullRequest[]> {
    this.logger.info('Running workspace plugin');

    const [inScopeCandidates, outOfScopeCandidates] = candidates.reduce(
      (collection, candidate) => {
        if (!candidate.pullRequest.version) {
          this.logger.warn('pull request missing version', candidate);
          return collection;
        }
        if (this.inScope(candidate)) {
          collection[0].push(candidate);
        } else {
          collection[1].push(candidate);
        }
        return collection;
      },
      [[], []] as CandidateReleasePullRequest[][]
    );

    this.logger.info(`Found ${inScopeCandidates.length} in-scope releases`);
    if (inScopeCandidates.length === 0) {
      return outOfScopeCandidates;
    }

    this.logger.info('Building list of all packages');
    const {allPackages, candidatesByPackage} =
      await this.buildAllPackages(inScopeCandidates);
    this.logger.info(
      `Building dependency graph for ${allPackages.length} packages`
    );
    const graph = await this.buildGraph(allPackages);

    const packageNamesToUpdate = this.packageNamesToUpdate(
      graph,
      candidatesByPackage
    );
    const orderedPackages = this.buildGraphOrder(graph, packageNamesToUpdate);
    this.logger.info(`Updating ${orderedPackages.length} packages`);

    const {updatedVersions, updatedPathVersions} =
      await this.buildUpdatedVersions(
        graph,
        orderedPackages,
        candidatesByPackage
      );

    let newCandidates: CandidateReleasePullRequest[] = [];
    // In some cases, there are multiple packages within a single candidate. We
    // only want to process each candidate package once.
    const newCandidatePaths = new Set<string>();
    for (const pkg of orderedPackages) {
      const existingCandidate = this.findCandidateForPackage(
        pkg,
        candidatesByPackage
      );
      if (existingCandidate) {
        // if already has an pull request, update the changelog and update
        this.logger.info(
          `Updating exising candidate pull request for ${this.packageNameFromPackage(
            pkg
          )}, path: ${existingCandidate.path}`
        );
        if (newCandidatePaths.has(existingCandidate.path)) {
          this.logger.info(
            `Already updated candidate for path: ${existingCandidate.path}`
          );
        } else {
          const newCandidate = this.updateCandidate(
            existingCandidate,
            pkg,
            updatedVersions
          );
          newCandidatePaths.add(newCandidate.path);
          newCandidates.push(newCandidate);
        }
      } else {
        // otherwise, build a new pull request with changelog and entry update
        this.logger.info(
          `Creating new candidate pull request for ${this.packageNameFromPackage(
            pkg
          )}`
        );
        const newCandidate = this.newCandidate(pkg, updatedVersions);
        if (newCandidatePaths.has(newCandidate.path)) {
          this.logger.info(
            `Already created new candidate for path: ${newCandidate.path}`
          );
        } else {
          newCandidatePaths.add(newCandidate.path);
          newCandidates.push(newCandidate);
        }
      }
    }

    if (this.merge) {
      this.logger.info(`Merging ${newCandidates.length} in-scope candidates`);
      const mergePlugin = new Merge(
        this.github,
        this.targetBranch,
        this.repositoryConfig
      );
      newCandidates = await mergePlugin.run(newCandidates);
    }

    const newUpdates = newCandidates[0].pullRequest.updates;
    newUpdates.push({
      path: this.manifestPath,
      createIfMissing: false,
      updater: new ReleasePleaseManifest({
        version: newCandidates[0].pullRequest.version!,
        versionsMap: updatedPathVersions,
      }),
    });

    this.logger.info(
      `Post-processing ${newCandidates.length} in-scope candidates`
    );
    newCandidates = this.postProcessCandidates(newCandidates, updatedVersions);
    this.logger.info('Updating docs and examples');
    newCandidates = await this.updateDocsAndExamples(
      newCandidates,
      allPackages
    );

    return [...outOfScopeCandidates, ...newCandidates];
  }

  async updateDocsAndExamples(
    candidates: CandidateReleasePullRequest[],
    allPackages: CrateInfo[]
  ): Promise<CandidateReleasePullRequest[]> {
    let rootCandidate = candidates.find(c => c.path === ROOT_PROJECT_PATH);
    if (!rootCandidate) {
      this.logger.warn('Unable to find root candidate pull request');
      rootCandidate = candidates.find(c => c.config.releaseType === 'rust');
    }
    if (!rootCandidate) {
      this.logger.warn('Unable to find a rust candidate pull request');
      return candidates;
    }

    await this.overwriteDirectory(
      rootCandidate,
      'docs/docusaurus/docs',
      'docs/docusaurus/versioned_docs/version-release',
      ['docs-config.json']
    );
    await this.overwriteDirectory(
      rootCandidate,
      'examples/latest',
      'examples/release',
      ['Cargo.toml', 'Justfile']
    );
    await this.removeReleaseExamplePathDependencies(
      rootCandidate,
      allPackages
    );
    await this.updateReleaseExampleWorkspaceToml(rootCandidate);

    return candidates;
  }

  async updateReleaseExampleWorkspaceToml(
    rootCandidate: CandidateReleasePullRequest
  ) {
    let targetFiles = await this.github.findFilesByGlobAndRef(
      '**/Cargo.toml',
      this.targetBranch,
      'examples/latest'
    );
    let members = targetFiles.map(file => {
      return file.slice(0, -'/Cargo.toml'.length);
    });
    rootCandidate.pullRequest.updates.push({
      path: 'examples/release/Cargo.toml',
      createIfMissing: true,
      updater: new CargoWorkspaceMembers(members),
    });
  }

  async removeReleaseExamplePathDependencies(
    rootCandidate: CandidateReleasePullRequest,
    allPackages: CrateInfo[]
  ) {
    let targetFiles = await this.github.findFilesByGlobAndRef(
      '**/Cargo.toml',
      this.targetBranch,
      'examples/latest'
    );
    targetFiles.forEach(file => {
      file = 'examples/release/' + file;
      const fileUpdate = rootCandidate.pullRequest.updates.find(
        update => update.path === file
      );
      if (fileUpdate) {
        fileUpdate.updater = new CompositeUpdater(
          fileUpdate.updater,
          new CargoTomlRemovePaths(
            allPackages
          )
        );
      }
    });
  }

  async getFileContent(
    fileUpdate: Update | null,
    sourcePath: string
  ): Promise<FileContent | null> {
    try {
      let ghContents =
        fileUpdate?.cachedFileContents ||
        (await this.github.getFileContentsOnBranch(
          sourcePath,
          this.targetBranch
        ));
      if (isUtf8(Buffer.from(ghContents.content, 'base64'))) {
        return {
          content: ghContents.parsedContent,
          encoding: 'utf-8',
        };
      } else {
        return {
          content: ghContents.content,
          encoding: 'base64',
        };
      }
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        return fileUpdate && fileUpdate.createIfMissing
          ? {content: '', encoding: 'utf-8'}
          : null;
      }
      throw e;
    }
  }

  async overwriteFile(
    rootCandidate: CandidateReleasePullRequest,
    sourcePath: string,
    targetPath: string
  ) {
    this.logger.info(`Overwriting ${targetPath} with ${sourcePath}`);
    // Apply updates attached to the source file in `rootCandidate`,
    // then overwrite the target file with the final content.
    const fileUpdate =
      rootCandidate.pullRequest.updates.find(
        update => update.path === sourcePath
      ) ?? null;

    const fileContent = await this.getFileContent(fileUpdate, sourcePath);
    const newFileContent = fileContent
      ? fileUpdate
        ? fileUpdate.updater.updateContent(fileContent.content)
        : fileContent.content
      : null;

    let update = {
      path: targetPath,
      createIfMissing: true,
      updater: newFileContent
        ? new RawContent(
            newFileContent,
            fileContent ? fileContent.encoding : 'utf-8'
          )
        : new RemoveFile(),
    };
    rootCandidate.pullRequest.updates.push(update);
  }

  async findAllFilesInDir(dir: string): Promise<Set<string>> {
    let files = new Set(
      await this.github.findFilesByGlobAndRef('**/*', this.targetBranch, dir)
    );

    for (const file of files) {
      files.delete(file.substring(0, file.lastIndexOf('/')));
    }

    return files;
  }

  async overwriteDirectory(
    rootCandidate: CandidateReleasePullRequest,
    sourceDir: string,
    targetDir: string,
    exceptions: string[] = []
  ) {
    let targetFiles = await this.findAllFilesInDir(targetDir);

    // Overwrite or remove files in `targetDir`.
    for (const file of targetFiles) {
      const sourcePath = sourceDir + '/' + file;
      const targetPath = targetDir + '/' + file;
      if (!exceptions.includes(file)) {
        await this.overwriteFile(rootCandidate, sourcePath, targetPath);
      }
    }

    // Create new files in `targetDir` if they are present only in `sourceDir`.
    let sourceFiles = await this.findAllFilesInDir(sourceDir);

    for (const file of sourceFiles) {
      const sourcePath = sourceDir + '/' + file;
      const targetPath = targetDir + '/' + file;
      const exists = rootCandidate.pullRequest.updates.find(
        update => update.path === targetPath
      );
      if (!exists && !exceptions.includes(file)) {
        await this.overwriteFile(rootCandidate, sourcePath, targetPath);
      }
    }
  }
}
