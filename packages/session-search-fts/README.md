# @pid/session-search-fts

Pluggable asynchronous SQLite FTS5 full-text search index for `@pid/session`.

Listens to session lifecycle events (`session/created`, `session/event`, `session/flush`, `session/deleted`) and batches tokenization + SQLite FTS5 updates off the synchronous `session.append()` path, while flushing any dirty sessions before `sessions.search()` runs so search results are always immediately consistent.
