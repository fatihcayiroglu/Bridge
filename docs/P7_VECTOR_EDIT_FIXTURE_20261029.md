# Federation vector-edit fixture — bounded correction, acceptance open

First integration run [40926717030](https://github.com/fatihcayiroglu/Bridge/actions/runs/40926717030)
on `45a2ad5f` reported 142 PASS, one FAIL (F-VEC-06), and seven MEASURED.
The failed check reported a successful edit but an old-word vector-search match.
Its preserved artifact `12921706414` has SHA-256
`cf7bd6fca15a95c542c4e5cae0bcadbd70bc6cb43b04b82d6fedb91f1dad2ae3`.
The artifact does not contain the fixture's random tag or the individual
re-embedding/search assertion values. Its historical cause cannot be established
from that summary. The later unmodified-harness run on `9b67078d` succeeding
does not prove a correction or erase the first failure.

The actual lab `hashEmbed` function maps words into 767 feature bins. Different
spellings do not guarantee different bins. A controlled enumeration of 10,000
eight-character base-36 tags found 40 cases where `draft<tag>` matches the
**correct** vector for `kangaroo final<tag> plan` above the unchanged 0.3
production threshold. Tag `00000001` reproduces similarity 0.5773695. This
proves a defective fixture premise, not the cause of the unarchived CI tag.

The edit journey now uses fixed, distinct feature markers in its newly isolated
server. Before any edit, the lab records all four query/content cosine values
and fails if their geometry cannot distinguish old and new content. The lab
explicitly selects the unchanged production default of 0.3. Production search,
embedding, index and cache code are untouched. No timeout, retry or acceptance
threshold is increased.

F-VEC-06 retains its changed-vector, exact new embedding, provider prompt,
old-result exclusion and new-result inclusion assertions. It additionally proves
that the old search found the original message and that the new search did not,
using another authorized actor so this index journey does not warm the
post-edit actor's cache. Both successful searches must use pgvector. Bounded
booleans now distinguish each transition in the failure report without logging
message text, user identifiers, vectors or secrets. The existing plaintext-log
check inspects the new fixture's actual markers.

Local checks: seven fixture controls pass with zero skipped tests, including the
former collision, incompatible-dimension refusal and four real HTTP embedder
requests. The existing 223 release-integrity checks, script syntax and workflow
YAML checks pass. Real PostgreSQL/pgvector, Redis, HTTPS installations and the
accelerated retry lab still require the new exact-head federation run. This
harness correction does not claim production semantic-search quality or full
P7 acceptance. Keep #321/#209/P7 open; inherited #375 integration still requires
explicit owner approval before main.
