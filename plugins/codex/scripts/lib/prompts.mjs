import fs from "node:fs";
import path from "node:path";

/** @param {string} rootDir @param {string} name */
export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

/**
 * @param {string} template
 * @param {Readonly<Record<string, string>>} variables
 */
export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}
