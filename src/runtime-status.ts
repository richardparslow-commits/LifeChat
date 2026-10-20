/**
 * Runtime status shared between the startup preflight and the HTTP app.
 *
 * The preflight (entry point) and the /health route (app) live in different
 * modules now, so the one piece of mutable status they share lives here rather
 * than as a module-level `let` inside the route table.
 */

let dataPathsWritable = true;

/** Whether the record log directories were writable at startup. */
export function isDataPathsWritable(): boolean {
  return dataPathsWritable;
}

/** Records the preflight's verdict so /health can report it. */
export function setDataPathsWritable(value: boolean): void {
  dataPathsWritable = value;
}
