# Filtered session search

## Built

- Added `SEARCH_EVENTS_BASE` / `SEARCH_EVENTS_TRI_BASE`, with the `projects` join and no
  ordering or limit, so `searchEventsFiltered` can append only fixed SQL fragments selected
  by filter presence.
- Added composable `project`, `tier`, `since`, and `until` filters. Project binds the same
  `%substring%` value against both `projects.cwd` and `projects.dir_name`; tier is exact;
  time bounds are inclusive comparisons against `sessions.started_at`.
- Kept the original `searchEvents` API and shared its row-to-hit dedupe with the new path.
- Extended CLI `search` flags/help and the MCP `search_sessions` schema/call path.
- Added explicit boundary validation for the three known tier values. Date strings are not
  parsed or normalized: they are bound verbatim as ISO-8601 text, matching Store.swift and
  avoiding silent timezone/precision changes.

## Verification

All commands ran from `ψ/lab/session-search/` against session-viewer's live database,
opened read-only.

### Typecheck and regression selftest

```text
$ bunx tsc --noEmit
(no output; exit 0)

$ bun src/cli.ts selftest
✓ horizon partition: 817 assertions passed
```

### Existing search vs empty filtered search

```sh
bun -e 'import { Db } from "./src/db.ts"; import { searchEvents, searchEventsFiltered } from "./src/search.ts"; import { DEFAULT_DB } from "./src/const.ts"; const db = new Db(DEFAULT_DB); const a = searchEvents(db, "session-search", 100); const b = searchEventsFiltered(db, "session-search", {}, 100); console.log(`query=session-search unfiltered=${a.length} filtered_empty=${b.length} exact_json_match=${JSON.stringify(a) === JSON.stringify(b)}`); console.log(`first=${a[0]?.sessionId}:${a[0]?.seq} last=${a.at(-1)?.sessionId}:${a.at(-1)?.seq}`); db.close();'
```

```text
query=session-search unfiltered=5 filtered_empty=5 exact_json_match=true
first=1966:2984 last=1413:2840
```

The same equivalence also holds on the short-query unicode61 route:

```text
$ bun -e 'import { Db } from "./src/db.ts"; import { searchEvents, searchEventsFiltered } from "./src/search.ts"; import { DEFAULT_DB } from "./src/const.ts"; const db = new Db(DEFAULT_DB); const a=searchEvents(db,"9c",100); const b=searchEventsFiltered(db,"9c",{},100); console.log(`query=9c unicode61 unfiltered=${a.length} filtered_empty=${b.length} exact_json_match=${JSON.stringify(a)===JSON.stringify(b)}`); db.close();'
query=9c unicode61 unfiltered=100 filtered_empty=100 exact_json_match=true
```

The same unfiltered query through MCP also returned the same count:

```text
id=3 isError=false first_line=5 hits for "session-search"
```

### Tier filter, checked directly with sqlite3

```text
$ IDS=$(bun -e 'import { Db } from "./src/db.ts"; import { searchEvents, searchEventsFiltered } from "./src/search.ts"; import { DEFAULT_DB } from "./src/const.ts"; const db = new Db(DEFAULT_DB); const all = searchEvents(db, "session-search", 100); const hits = searchEventsFiltered(db, "session-search", {tier:"session"}, 100); console.log(hits.map(h => h.sessionId).join(",")); console.error(`unfiltered=${all.length} tier_session=${hits.length} ids=${hits.map(h => h.sessionId).join(",")}`); db.close();')
unfiltered=5 tier_session=3 ids=1966,9293,1413

$ DB=/opt/Code/github.com/Soul-Brews-Studio/digger-oracle/ψ/lab/session-viewer/.data/sessions.db
$ /usr/bin/sqlite3 -readonly "$DB" \
    "SELECT COUNT(*), SUM(s.file_tier='session'), GROUP_CONCAT(DISTINCT s.file_tier)
       FROM sessions s WHERE s.id IN (1966,9293,1413);"
3|3|session

$ /usr/bin/sqlite3 -readonly -header -column "$DB" \
    "SELECT s.id, s.file_tier, s.started_at
       FROM sessions s WHERE s.id IN (1966,9293,1413) ORDER BY s.id;"
id    file_tier  started_at
----  ---------  ------------------------
1413  session    2026-08-24T14:50:13.003Z
1966  session    2026-08-25T12:57:36.836Z
9293  session    2026-07-02T03:13:01.670Z
```

Thus the filtered result is `3 <= 5`, and every returned session has the exact requested
tier.

### Project filter, checked directly with sqlite3

```text
$ PIDS=$(bun -e 'import { Db } from "./src/db.ts"; import { searchEventsFiltered } from "./src/search.ts"; import { DEFAULT_DB } from "./src/const.ts"; const db = new Db(DEFAULT_DB); const hits = searchEventsFiltered(db, "session-search", {project:"digger-oracle"}, 100); console.log(hits.map(h => h.sessionId).join(",")); console.error(`project=digger-oracle hits=${hits.length} ids=${hits.map(h => h.sessionId).join(",")}`); db.close();')
project=digger-oracle hits=1 ids=9293

$ /usr/bin/sqlite3 -readonly "$DB" \
    "SELECT COUNT(*), SUM(p.cwd LIKE '%digger-oracle%'
                          OR p.dir_name LIKE '%digger-oracle%')
       FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id IN (9293);"
1|1

$ /usr/bin/sqlite3 -readonly -header -column "$DB" \
    "SELECT s.id, s.file_tier, s.started_at, p.cwd, p.dir_name
       FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id IN ($PIDS);"
id    file_tier  started_at                cwd                                                   dir_name
----  ---------  ------------------------  ----------------------------------------------------  ----------------------------------------------------
9293  session    2026-07-02T03:13:01.670Z  /opt/Code/github.com/Soul-Brews-Studio/digger-oracle  -opt-Code-github-com-Soul-Brews-Studio-digger-oracle
```

### All four filters composed, plus MCP schema/call

```text
$ bun -e 'import { Db } from "./src/db.ts"; import { searchEventsFiltered } from "./src/search.ts"; import { DEFAULT_DB } from "./src/const.ts"; const db = new Db(DEFAULT_DB); const filters={project:"digger-oracle",tier:"session",since:"2026-07-01T00:00:00.000Z",until:"2026-07-03T00:00:00.000Z"}; const hits=searchEventsFiltered(db,"session-search",filters,100); console.log(`filters=${JSON.stringify(filters)} hits=${hits.length} ids=${hits.map(h=>h.sessionId).join(",")}`); db.close();'
filters={"project":"digger-oracle","tier":"session","since":"2026-07-01T00:00:00.000Z","until":"2026-07-03T00:00:00.000Z"} hits=1 ids=9293

$ printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_sessions","arguments":{"query":"session-search","limit":100}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_sessions","arguments":{"query":"session-search","tier":"session","project":"digger-oracle","since":"2026-07-01T00:00:00.000Z","until":"2026-07-03T00:00:00.000Z","limit":100}}}' \
  | bun src/cli.ts mcp > /tmp/session-search-filtered-mcp.jsonl
$ jq -r 'select(.id==2) | .result.tools[] | select(.name=="search_sessions") | "schema_properties=" + (.inputSchema.properties | keys | join(",")) + " tier_enum=" + (.inputSchema.properties.tier.enum | join(","))' /tmp/session-search-filtered-mcp.jsonl
schema_properties=limit,project,query,since,tier,until tier_enum=session,subagent,workflow_agent
$ jq -r 'select(.id==3 or .id==4) | "id=" + (.id|tostring) + " isError=" + (.result.isError|tostring) + " first_line=" + (.result.content[0].text | split("\n")[0])' /tmp/session-search-filtered-mcp.jsonl
id=3 isError=false first_line=5 hits for "session-search"
id=4 isError=false first_line=1 hits for "session-search"
```

The filtered MCP call used all four filters shown above.
