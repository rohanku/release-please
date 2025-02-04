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

import * as TOMLParser from '@iarna/toml/lib/toml-parser';
import * as TOML from '@iarna/toml';

const CHAR_COMMA = 0x2c;
const taggedValueMarker = Symbol('__TAGGED_VALUE');

/**
 * The type for any value parsed by `TaggedTOMLParser`, including all kinds of
 * strings, numbers, dates, etc.
 */
interface TaggedValue {
  /** Type marker */
  [taggedValueMarker]: true;

  /** Byte offset of the comma before the assign statement */
  prev_comma?: number;

  /** Byte offset of the start of the assign statement */
  assign_start: number;

  /** Byte offset of the start of the value */
  start: number;

  /** Byte offset of the end of the value */
  end: number;

  /** Current contents of the string. May be shorter than (end-start), if the string had escape sequences */
  value: unknown;
}

/**
 * A custom variant of `TOMLParser` that replaces all values with a tagged
 * variant that includes their start and end positions, allowing them to be
 * replaced.
 */
class TaggedTOMLParser extends TOMLParser {
  parseAssign() {
    // Remember the start position of the value.
    //
    // Off-by-one correctness: by this point, `this.pos` points one character
    // *after* the first character of the value, which is in `this.char`
    this.state.__TAGGED_ASSIGN_START = this.pos - 1;

    return super.parseAssign();
  }

  parseValue() {
    // Remember the start position of the value.
    //
    // Off-by-one correctness: by this point, `this.pos` points one character
    // *after* the first character of the value, which is in `this.char`
    this.state.__TAGGED_START = this.pos - 1;

    return super.parseValue();
  }

  parseInlineTableNext() {
    if (this.char === CHAR_COMMA) {
      this.state.__TAGGED_PREV_COMMA = this.pos - 1;
    }
    return super.parseInlineTableNext();
  }

  call(fn: Function, returnWith: Function) {
    const prevState = this.state;
    super.call(fn, returnWith);

    // Carry over the start position. If it wasn't set, (say, if we were parsing
    // something other than a value), we're just assigning `undefined` here.
    this.state.__TAGGED_PREV_COMMA = prevState.__TAGGED_PREV_COMMA;
    this.state.__TAGGED_ASSIGN_START = prevState.__TAGGED_ASSIGN_START;
  }

  return(value: unknown) {
    const prevState = this.state;
    super.return(value); // `return` returns void

    if (prevState.__TAGGED_ASSIGN_START && prevState.__TAGGED_START) {
      // If the parser we just returned from remembered a start position,
      // tag the returned value with "start" and "end".
      // Note that we don't tag objects to avoid encountering multiple tagged
      // values when replacing later on.
      const taggedValue: TaggedValue = {
        [taggedValueMarker]: true,
        prev_comma: prevState.__TAGGED_PREV_COMMA,
        assign_start: prevState.__TAGGED_ASSIGN_START,
        start: prevState.__TAGGED_START,
        end: this.pos,
        value: this.state.returned,
      };

      this.state.returned = taggedValue;
    }
  }
}

/**
 * Parses input as TOML with the given parser
 * @param input A string
 * @param parserType The TOML parser to use (might be custom)
 */
export function parseWith(
  input: string,
  parserType: typeof TOMLParser = TaggedTOMLParser
): TOML.JsonMap {
  const parser = new parserType();
  parser.parse(input);
  return parser.finish();
}

function isTaggedValue(x: unknown): x is TaggedValue {
  if (!x) {
    return false;
  }

  if (typeof x !== 'object') {
    return false;
  }

  const ts = x as TaggedValue;
  return ts[taggedValueMarker] === true;
}

/**
 * Given TOML input and a path to a value, attempt to replace
 * that value without modifying the formatting.
 * @param input A string that's valid TOML
 * @param path Path to a value to replace. When replacing 'deps.tokio.version', pass ['deps', 'tokio', 'version']. The value must already exist.
 * @param newValue The value to replace the value at `path` with. Is passed through `TOML.stringify()` when replacing: strings will end up being double-quoted strings, properly escaped. Numbers will be numbers.
 */
export function replaceTomlValue(
  input: string,
  path: (string | number)[],
  newValue: TOML.AnyJson | null
) {
  // our pointer into the object "tree", initially points to the root.
  let current = parseWith(input, TaggedTOMLParser) as Record<string, unknown>;

  // navigate down the object tree, following the path, expecting only objects.
  // Note that tagged strings (generated by `TaggedTOMLParser`) are also objects.
  for (let i = 0; i < path.length; i++) {
    const key = path[i];

    // // We may encounter tagged values when descending through the object tree
    if (isTaggedValue(current)) {
      if (!current.value || typeof current.value !== 'object') {
        const msg = `partial path does not lead to table: ${path
          .slice(0, i)
          .join('.')}`;
        throw new Error(msg);
      }
      current = current.value as Record<string, unknown>;
    }

    const next = current[key];

    if (typeof next !== 'object') {
      const msg = `path not found in object: ${path.slice(0, i + 1).join('.')}`;
      throw new Error(msg);
    }
    current = next as TOML.JsonMap;
  }

  if (!isTaggedValue(current)) {
    const msg = `value at path ${path.join('.')} is not tagged`;
    throw new Error(msg);
  }

  let output;

  if (newValue) {
    const before = input.slice(0, current.start);
    const after = input.slice(current.end);
    output = before + TOML.stringify.value(newValue) + after;
  } else {
    const before = input.slice(0, current.prev_comma ?? current.assign_start);
    const after = input.slice(current.end);
    output = before + after;
  }

  try {
    parseWith(output, TOMLParser);
  } catch (e) {
    throw new Error(`After replacing value, result is not valid TOML: ${e}`);
  }

  return output;
}
