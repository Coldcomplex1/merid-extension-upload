# Product & Technical Roadmap — Merid

Honest, practical suggestions for taking this from “audited MVP” to a real product.
I’ve flagged what’s worth doing now vs. later, and called out ideas that sound nice
but aren’t worth building yet.

---

## 1. Must‑have improvements before publishing

| Improvement | Why it matters / problem solved | Difficulty | Before publish? |
|---|---|---|---|
| **Revoke leaked key + deploy proxy** | The old key is compromised; the proxy is the whole security model. | Easy | **Yes — hard blocker** |
| **Real 16/48/128 icons + store screenshots** | Reviewers and users judge on these; one stretched PNG looks unfinished. | Easy | **Yes** |
| **Set `ALLOWED_EXTENSION_IDS` on the proxy** | Stops random extensions/sites burning your OpenAI budget. | Easy | **Yes** (right after you have a stable ID) |
| **Cost guardrails on the proxy** (daily cap / per‑IP budget) | One abusive user shouldn’t cost you $100 overnight. | Medium | **Yes** — even a crude daily counter |
| **First‑run onboarding** (1 screen: what it does, how to configure) | New users won’t discover the context check / modes otherwise. | Easy | Strongly recommended |
| **Empty/error states in the popup** (“No matches on this page”, “Backend unreachable”) | Silent nothing feels broken. Status line exists; add the messages. | Easy | Recommended |
| **Debug/log toggle** (off by default) | Current `console.log`s are noisy in users’ consoles. | Easy | Recommended |
| **Real 16/48/128 icons** already listed; also verify **Vietnamese UI copy** | Your users are Vietnamese; an English‑only popup adds friction. | Medium | Recommended |

Everything security/permissions/privacy‑related in [`AUDIT.md`](AUDIT.md) is already
done; the above is what’s left to feel “launch‑quality”.

---

## 2. High‑impact product improvements

| Idea | User value | Complexity | MVP priority | Technical approach |
|---|---|---|---|---|
| **Rich hover tooltip** (meaning + IPA + example + audio) | Turns a swap into a micro‑lesson | Low (mostly built) | **P1** | Already present; add IPA from `phon_*` columns, cache TTS |
| **Save to personal list** | Lets learners revisit words they liked | Low | **P1** | Removed in round 2 to focus on context checking; re‑add a local `chrome.storage.local` deck + export/import JSON |
| **“I already know this” button** | Stops nagging on known words; personalizes | Low | **P1** | Removed in round 2; re‑add a `knownWords` filter + count in popup |
| **“Show original Vietnamese” toggle** | Reduces confusion when a swap is jarring | Low | **P1** | The `highlight` display mode already does this per‑word; add a global quick‑toggle |
| **Spaced‑repetition review** of saved words | The single biggest retention lever | Medium | **P2** | Store SM‑2 fields per deck word; a review page (new tab) quizzes due cards |
| **Daily word goal + streaks** | Habit formation, retention | Medium | **P2** | Count replaced/mastered per day (stats exist); streak = consecutive days |
| **Mini quiz after browsing** | Active recall on words seen today | Medium | **P2** | Pull today’s replaced words from cache, 4‑option MCQ from dataset |
| **Vietnamese explanation for hard English words** | Lowers cognitive load for lower levels | Low | **P2** | Already have `vietnamese` column; show it prominently in `highlight` mode |
| **Word difficulty personalization** | Right challenge level = more learning | Medium | **P3** | Track per‑word exposures/known; bias selection toward the user’s edge |
| **Word history by website** | “Where did I see this?” aids memory | Low | **P3** | Log `{word, host, ts}` locally; show in deck |
| **Cross‑device sync of deck/progress** | Expected of a real product | Hard | **P3** | Needs the account backend (see §4); until then `chrome.storage.sync` for *settings* only (size‑limited) |
| **Gamification (badges/levels)** | Motivation, but easy to overdo | Medium | **P3 / optional** | Derive from existing stats; keep it lightweight, not central |

Honesty check: badges/streaks are motivating but **not** why people stay — retention
comes from the spaced‑repetition + quiz loop (P2). Build that before gamification.

---

## 3. Learning‑science improvements (practical)

- **Repeated, spaced exposure beats one‑off swaps.** Track how many times a user has
  *seen* a word; only mark it “learned” after N spaced exposures, then quiz it. The
  cache already counts usage — extend it per‑user‑word.
- **Active recall, not just recognition.** Passive replacement is recognition‑level.
  Add a lightweight recall prompt: occasionally show the Vietnamese and ask the user
  to recall the English before revealing (a “cloze” mode).
- **Prevent skimming past replacements.** Subtle animation on first appearance, and an
  optional “tap to reveal meaning” for a fraction of words, forces a moment of attention.
- **Avoid cognitive overload.** The intensity slider helps; also cap *distinct new
  words per page* (not just total replacements) so a page doesn’t dump 40 new words.
- **CEFR/SAT progression.** Introduce words near the user’s level first; promote to
  harder sets as mastery grows, rather than mixing C2 into a beginner’s browsing.
- **Example‑based learning.** Always pair the word with the sentence it appeared in
  (the context you already capture) in the review/quiz — context‑bound memory sticks.
- **Long‑term retention = scheduling.** SM‑2/Leitner scheduling on the deck is the
  highest‑leverage learning feature; everything else is secondary.

---

## 4. Technical architecture improvements

| Suggestion | Tradeoff |
|---|---|
| **Move pure logic fully into `lib/` modules** (matching, scheduling, stats) | More files/indirection, but far easier to test and reuse across popup/options/review pages. Started with `vocab-core.js`. |
| **Precompiled/normalized vocabulary index** (build‑time JSON instead of CSV parse at runtime) | Faster loads and smaller memory; adds a build step. Worth it once datasets grow or B2/quiz features land. |
| **Caching layer with TTL + versioning** | Slightly more code; prevents stale AI decisions and unbounded growth. Cache is bounded now; add TTL next. |
| **Phrase‑matching via a trie/Aho‑Corasick** | The current 3/2/1 window is fine for ~3k words; a trie scales to 50k+ and multi‑word phrases without re‑scanning. Do it only if datasets get large. |
| **Request queue + client‑side rate limiting** | Smooths bursts and cost; a bit more state. The batch queue exists; add a token bucket. |
| **Proxy rate limiting via KV/Durable Objects** | Durable, global limits vs. the current per‑isolate best‑effort. Small cost, real anti‑abuse. Do before heavy traffic. |
| **Local‑first mode as a first‑class product tier** | Zero‑network is a privacy selling point; keep it the default and market it. Free win. |
| **Account/sync backend** (replaces removed Firebase) | Real cross‑device sync + teacher features, but it’s a real service to run/secure. Use Firebase **with proper auth + locked‑down security rules** or Supabase; never the old open‑REST pattern. |
| **TypeScript migration** | Upfront churn + build step; big payoff in safety as the codebase grows. Added JSDoc typedefs now as a bridge. |
| **Structured logging + debug mode** | Tiny; replace ad‑hoc `console.log` with a gated logger so production is quiet. |
| **Privacy‑respecting analytics** (aggregate counts, opt‑in, no page content) | Helps prioritize features; must be opt‑in and content‑free to keep the privacy promise. Self‑host or use a privacy‑first vendor. |

---

## 5. Monetization & growth (realistic)

**Do now (cheap, compounding):**
- A simple **landing page + waitlist** describing the product; link from the store.
- **Chrome Web Store listing optimization**: Vietnamese title/description, keyword
  research (“học từ vựng tiếng Anh”, “IELTS vocabulary”), strong screenshots.
- Seed in **Vietnamese student communities** (Facebook groups, university subreddits,
  TikTok demos of words changing on a real news site — very shareable).

**Later (needs the account backend + real usage):**
- **Free vs. Premium**: free = local + BYOK/limited proxy; premium = hosted context
  check (no key needed), unlimited, spaced‑repetition + quizzes, sync.
- **Exam packs**: IELTS / TOEFL / SAT curated sets as premium content — clear value,
  reuses the dataset pipeline.
- **School/classroom tier + teacher dashboard**: assign lists, track class progress.
  High value, but only after the single‑user product is sticky.
- **Referral loop / social sharing**: “I learned 500 words browsing the news” share
  cards. Cheap virality once the review/streak loop exists.

Honesty check: don’t build the teacher dashboard, referrals, or premium billing until
the core learning loop (§3 P2) retains individual users. Monetizing an unproven loop
wastes months.

---

## 6. Final recommendation roadmap

### Phase 1 — Publishable MVP (do these to ship safely)

| Item | Priority | Difficulty | Reason / path |
|---|---|---|---|
| Revoke old key, deploy proxy, set `ALLOWED_EXTENSION_IDS` | Critical | Easy | Security model; `backend/README.md` |
| Proxy cost cap (daily/IP budget) | Critical | Medium | Prevent runaway spend; counter in KV or a simple in‑Worker daily cap |
| Real icons + screenshots + Vietnamese store copy | High | Easy | Listing quality; design assets |
| First‑run onboarding + popup empty/error states | High | Easy | Comprehension; one options‑page banner + status strings |
| Debug‑log toggle (quiet by default) | Medium | Easy | Professional polish; gate `console.log` |
| Add real 16/48/128 icons | High | Easy | Store requirement |

### Phase 2 — Strong learning product (makes it genuinely useful)

| Item | Priority | Difficulty | Reason / path |
|---|---|---|---|
| Spaced‑repetition review page | Critical | Medium | Core retention; SM‑2 fields on deck + a review tab |
| Daily goal + streaks | High | Medium | Habit loop; reuse `masteryStats` |
| Mini quiz from today’s words | High | Medium | Active recall; MCQ from dataset + cache |
| “Cloze / reveal” recall mode | Medium | Medium | Deeper encoding; content‑script variant of `highlight` |
| Distinct‑new‑words‑per‑page cap | Medium | Easy | Avoids overload; small counter in `content.js` |
| Prominent Vietnamese gloss for hard words | Medium | Easy | Lowers load; already have the data |

### Phase 3 — Scalable product (growth, teams, longevity)

| Item | Priority | Difficulty | Reason / path |
|---|---|---|---|
| Account + secure sync backend | High | Hard | Cross‑device + premium; Supabase/Firebase **with auth + strict rules** |
| Free/Premium tiers + hosted context check | High | Hard | Monetization; billing + entitlement in the proxy |
| Exam packs (IELTS/TOEFL/SAT) | Medium | Medium | Clear paid value; dataset pipeline reuse |
| Teacher dashboard / classroom tier | Medium | Hard | B2B upside; only after individual retention proven |
| Trie/Aho‑Corasick matcher + build‑time index | Medium | Medium | Scale to large datasets; only when needed |
| TypeScript migration | Medium | Medium | Maintainability at scale; incremental |
| Privacy‑first opt‑in analytics | Low | Medium | Prioritization data without breaking the privacy promise |
| Referral / social share loop | Low | Medium | Virality; build after the learning loop is sticky |

**Bottom line:** Phase 1 is small and mostly operational — do it and ship. Phase 2 is
where this becomes a *learning* product rather than a word‑swapper; the
spaced‑repetition + quiz loop is the thing to build next. Defer Phase 3 (accounts,
billing, schools) until Phase 2 demonstrably retains users.
