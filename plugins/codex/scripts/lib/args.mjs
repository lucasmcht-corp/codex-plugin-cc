/**
 * @typedef {{
 *   valueOptions?: readonly string[],
 *   booleanOptions?: readonly string[],
 *   aliasMap?: Readonly<Record<string, string>>
 * }} ArgumentParserConfig
 *
 * @typedef {Record<string, string | boolean>} ParsedOptions
 * @typedef {{ value: string, start: number, end: number }} RawArgumentToken
 */

/**
 * @param {readonly string[]} argv
 * @param {ArgumentParserConfig} [config]
 * @returns {{ options: ParsedOptions, positionals: string[] }}
 */
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  /** @type {ParsedOptions} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

/** @param {string} raw @returns {RawArgumentToken[]} */
export function tokenizeRawArgumentString(raw) {
  /** @type {RawArgumentToken[]} */
  const tokens = [];
  let index = 0;

  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) {
      index += 1;
    }
    if (index >= raw.length) {
      break;
    }

    const start = index;
    let value = "";
    /** @type {"'" | "\"" | null} */
    let quote = null;

    while (index < raw.length) {
      const character = raw[index];
      if (quote !== null) {
        if (character === quote) {
          quote = null;
          index += 1;
          continue;
        }
        if (character === "\\") {
          const next = raw[index + 1];
          if (next === quote) {
            value += next;
            index += 2;
            continue;
          }
        }
        value += character;
        index += 1;
        continue;
      }

      if (/\s/.test(character)) {
        break;
      }
      if (character === "'" || character === "\"") {
        quote = character;
        index += 1;
        continue;
      }
      if (character === "\\") {
        const next = raw[index + 1];
        if (
          next !== undefined &&
          (/\s/.test(next) || next === "'" || next === "\"")
        ) {
          value += next;
          index += 2;
          continue;
        }
      }
      value += character;
      index += 1;
    }

    if (quote !== null) {
      throw new Error("Unterminated quote in raw arguments.");
    }
    tokens.push({ value, start, end: index });
  }

  return tokens;
}

/** @param {string} raw */
export function splitRawArgumentString(raw) {
  return tokenizeRawArgumentString(raw).map((token) => token.value);
}
