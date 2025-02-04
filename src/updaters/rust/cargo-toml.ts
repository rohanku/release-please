// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {replaceTomlValue} from '../../util/toml-edit';
import {CrateInfo} from '../../plugins/cargo-workspace';
import {DEP_KINDS, parseCargoManifest} from './common';
import {logger as defaultLogger, Logger} from '../../util/logger';
import {DefaultUpdater} from '../default';

/**
 * Updates `Cargo.toml` manifests, preserving formatting and comments.
 */
export class CargoToml extends DefaultUpdater {
  /**
   * Given initial file contents, return updated contents.
   * @param {string} content The initial content
   * @returns {string} The updated content
   */
  updateContent(content: string, logger: Logger = defaultLogger): string {
    let payload = content;

    if (!this.versionsMap) {
      throw new Error('updateContent called with no versions');
    }

    const parsed = parseCargoManifest(payload);
    if (!parsed.package) {
      const msg = 'is not a package manifest (might be a cargo workspace)';
      logger.error(msg);
      throw new Error(msg);
    }
    payload = replaceTomlValue(
      payload,
      ['package', 'version'],
      this.version.toString()
    );

    for (const [pkgName, pkgVersion] of this.versionsMap) {
      for (const depKind of DEP_KINDS) {
        const deps = parsed[depKind];

        if (!deps) {
          continue; // to next depKind
        }

        if (!deps[pkgName]) {
          continue; // to next depKind
        }

        const dep = deps[pkgName];

        if (typeof dep === 'string' || typeof dep.path === 'undefined') {
          logger.info(`skipping ${depKind}.${pkgName} (no path set)`);
          continue; // to next depKind
        }

        if (typeof dep.version === 'undefined') {
          logger.info(`skipping ${depKind}.${pkgName} (no version set)`);
          continue; // to next depKind
        }

        let updatedVersion =
          depKind === 'dev-dependencies'
            ? `<=${pkgVersion.toString()}`
            : pkgVersion.toString();
        logger.info(
          `updating ${depKind}.${pkgName} from ${dep.version} to ${updatedVersion}`
        );
        payload = replaceTomlValue(
          payload,
          [depKind, pkgName, 'version'],
          updatedVersion
        );
      }

      // Update platform-specific dependencies
      if (parsed.target) {
        for (const targetName of Object.keys(parsed.target)) {
          for (const depKind of DEP_KINDS) {
            const deps = parsed.target[targetName][depKind];

            if (!deps) {
              continue; // to next depKind
            }

            if (!deps[pkgName]) {
              continue; // to next depKind
            }

            const dep = deps[pkgName];

            if (typeof dep === 'string' || typeof dep.path === 'undefined') {
              logger.info(
                `skipping target.${targetName}.${depKind}.${pkgName} in`
              );
              continue; // to next depKind
            }

            let updatedVersion =
              depKind === 'dev-dependencies'
                ? `<=${pkgVersion.toString()}`
                : pkgVersion.toString();
            logger.info(
              `updating  target.${targetName}.${depKind}.${pkgName} from ${dep.version} to ${updatedVersion}`
            );
            payload = replaceTomlValue(
              payload,
              ['target', targetName, depKind, pkgName, 'version'],
              updatedVersion
            );
          }
        }
      }
    }

    return payload;
  }
}

/**
 * Removes path dependencies from `Cargo.toml` manifests.
 */
export class CargoTomlRemovePaths {
  allPackages: CrateInfo[];
  constructor(allPackages: CrateInfo[]) {
    this.allPackages = allPackages;
  }
  /**
   * Given initial file contents, return updated contents.
   * @param {string} content The initial content
   * @returns {string} The updated content
   */
  updateContent(content: string, logger: Logger = defaultLogger): string {
    let payload = content;

    const parsed = parseCargoManifest(payload);
    if (!parsed.package) {
      const msg = 'is not a package manifest (might be a cargo workspace)';
      logger.error(msg);
      throw new Error(msg);
    }

    for (const { name } of this.allPackages) {
      for (const depKind of DEP_KINDS) {
        const deps = parsed[depKind];

        if (!deps) {
          continue; // to next depKind
        }

        if (!deps[name]) {
          continue; // to next depKind
        }

        const dep = deps[name];

        if (typeof dep === 'string' || typeof dep.path === 'undefined') {
          logger.info(`skipping ${depKind}.${name} (no path set)`);
          continue; // to next depKind
        }

        payload = replaceTomlValue(payload, [depKind, name, 'path'], null);
      }

      // Update platform-specific dependencies
      if (parsed.target) {
        for (const targetName of Object.keys(parsed.target)) {
          for (const depKind of DEP_KINDS) {
            const deps = parsed.target[targetName][depKind];

            if (!deps) {
              continue; // to next depKind
            }

            if (!deps[name]) {
              continue; // to next depKind
            }

            const dep = deps[name];

            if (typeof dep === 'string' || typeof dep.path === 'undefined') {
              logger.info(
                `skipping target.${targetName}.${depKind}.${name} in`
              );
              continue; // to next depKind
            }
            payload = replaceTomlValue(
              payload,
              ['target', targetName, depKind, name, 'path'],
              null
            );
          }
        }
      }
    }

    return payload;
  }
}

/**
 * Updates `Cargo.toml` manifests, preserving formatting and comments.
 */
export class CargoWorkspaceMembers {
  members: string[];
  constructor(members: string[]) {
    this.members = members;
  }
  /**
   * Given initial file contents, return updated contents.
   * @param {string} content The initial content
   * @returns {string} The updated content
   */
  updateContent(content: string, logger: Logger = defaultLogger): string {
    let payload = content;

    payload = replaceTomlValue(payload, ['workspace', 'members'], this.members);

    return payload;
  }
}
