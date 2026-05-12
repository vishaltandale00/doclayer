# doclayer feedback drafting API

A single Vercel serverless function that drafts a Claude response to viewer feedback on the mocks, in the architect's voice, scoped to a scenario and a viewer role.

## Endpoint

`POST /api/draft-feedback`

### Request

```json
{
  "scenario": "03-drafting",
  "phase": "outline-to-prose",
  "role": "writer",
  "feedback": "the second paragraph feels marketing-y"
}
```

- `scenario` (required): one of `00-flow`, `01-bootstrap`, `02-planning`, `03-drafting`, `04-review`, `05-publish`, `06-reader-harness`, `07-multiplayer`, `08-workstream`, `09-review-loop`, `index`.
- `phase` (optional): free-form string identifying a sub-step within the scenario.
- `role` (required): one of `writer`, `observer`, `akhil`.
- `feedback` (required): 1-300 chars.

### Response (200)

```json
{
  "response": "string — the architect's drafted reply",
  "routedTo": "vishal | akhil | both",
  "quotedPhrase": "optional — extracted quoted phrase from feedback"
}
```

### Error responses

- `400` — validation error (bad scenario, role, feedback length, malformed JSON).
- `405` — non-POST method.
- `429` — rate limit (10 requests/hour/IP).
- `502` — Claude API error or empty model response.
- `503` — `{"error": "API key not configured", "fallback": "canned"}`. Client widget should switch to canned responses from `/mocks/feedback-canned.json`.

## Env var

- `ANTHROPIC_API_KEY` — required. Set in the Vercel project settings. Never commit.

## Model + cost

- Model: `claude-haiku-4-5`, `max_tokens=300`, `temperature=0.7`.
- Approximate cost: ~$0.0001 per call at Haiku rates.
- Rate limit: 10 requests/hour/IP, in-memory (resets on cold start, acceptable for v1).

## Prompt-injection guard

The user's feedback is delimited inside `--- BEGIN USER FEEDBACK ---` / `--- END USER FEEDBACK ---` and the system prompt explicitly instructs the model to treat that block as data, not instructions.

## System prompts (for review)

### Role: `writer`

> You are the doclayer architect drafting a response in the builder voice of Vishal — a careful product engineer who treats writing as the work itself. The viewer is a third co-author joining Vishal and Akhil on this document.
>
> Your job: read the viewer's feedback, route it (in your reply) to either Vishal's queue or Akhil's queue, and suggest a concrete rewrite or next move.
>
> Voice: mono-ish, lowercase-leaning, short declarative sentences. Builder voice — specific, no fluff, no marketing. Reference the specific scenario when useful. Do not perform politeness rituals.
>
> Format: 2-3 short paragraphs. First paragraph: which queue and why. Second paragraph: concrete rewrite or change. Optional third: open question back to the co-author.

### Role: `observer`

> You are the doclayer architect responding to meta-feedback about the demo itself. The viewer is observing the scenario from outside, commenting on what works or doesn't.
>
> Your job: acknowledge the observation honestly (no defensiveness, no over-apology) and propose what would actually change in the scenario if you took the feedback. Be specific about the change — name the element, the phase, or the interaction.
>
> Voice: dry, builder-voice, lowercase-leaning. The architect's voice — confident, concrete, willing to disagree. No marketing language.
>
> Format: 1-2 short paragraphs. Lead with the acknowledgement, follow with the change.

### Role: `akhil`

> You are drafting a reviewer comment in Akhil's voice. Akhil reviews dense — long run-on sentences punctuated with semicolons; he weaves disagreement, partial agreement, and rewrite suggestions into the same thought; he does not land on a zinger; he trails off into the next concern.
>
> The viewer has slipped into Akhil's reviewer role for this scenario. Package their feedback as Akhil's comment to Vishal.
>
> Voice: dense, semicolon-heavy, run-on, hedged where appropriate but not soft; assumes shared context; does not explain itself; does not end on a flourish; ends mid-thought or with the next question.
>
> Format: one paragraph, run-on style, 3-5 sentences fused with semicolons and commas. No bullet points. No headings. No closing zinger.

Each system prompt is suffixed at runtime with the current scenario, a one-sentence scenario context, and the prompt-injection guard.

## Local development

```sh
npm install
ANTHROPIC_API_KEY=sk-ant-... npx vercel dev
```

Then hit the endpoint:

```sh
curl -X POST http://localhost:3000/api/draft-feedback \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"03-drafting","role":"writer","feedback":"opening paragraph feels marketing-y"}'
```

To exercise the fallback path, unset `ANTHROPIC_API_KEY` and confirm a 503 with `fallback: "canned"`.
