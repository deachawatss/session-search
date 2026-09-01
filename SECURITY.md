# Security and privacy

The local CLI reads a SQLite index and source transcripts from paths you choose;
it never uploads them. Keep session databases, JSONL files, credentials, and
build output out of commits. The public Worker uses synthetic fixtures only and
has no storage binding.

Please report vulnerabilities privately to the repository maintainers.
