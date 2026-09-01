// db.ts — a READ-ONLY handle on session-viewer's index.
//
// `readonly: true` is load-bearing, not defensive. session-viewer writes this file; two
// writers with two definitions of "imported" is the failure listen-py's SPEC named
// outright ("the disease, not the cure"). Opening read-only makes that structurally
// impossible rather than merely discouraged — a write attempt raises
// "attempt to write a readonly database" instead of corrupting a 5.6 GB index.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export class Db {
  readonly handle: Database;
  readonly path: string;

  constructor(path: string) {
    if (!existsSync(path)) {
      throw new Error(
        `index not found: ${path}\n` +
          `session-search reads session-viewer's index but does not create one.\n` +
          `Build it first:  cd ../session-viewer && just init-db import`
      );
    }
    this.path = path;
    // create:false as well as readonly — without it a typo'd path would silently produce
    // an empty db and every query would truthfully report zero results.
    this.handle = new Database(path, { readonly: true, create: false });
  }

  close(): void {
    this.handle.close();
  }
}
