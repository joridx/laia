/**
 * TODO system for LAIA Brain.
 * Persistent task tracking across sessions.
 */

import { readJSON, writeFile } from "./file-io.js";
import { TODOS_FILE } from "./config.js";

export function readTodos() {
  return readJSON(TODOS_FILE) || [];
}

export function writeTodos(todos) {
  writeFile(TODOS_FILE, JSON.stringify(todos, null, 2));
}
