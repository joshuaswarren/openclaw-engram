/**
 * Synthetic inbox email fixture for ingestion benchmarks.
 *
 * All names, organisations, and content are entirely fictional.
 */

import type { FixtureGenerator, FixtureOutput } from "./types.js";
import { EMAIL_GOLD_GRAPH } from "./email-gold.js";

const EMAIL_FILES = [
  {
    relativePath: "emails/001-project-atlas-kickoff.txt",
    content: `From: Alice Nakamura <alice@acmecorp.example>
To: Bob Chen <bob@acmecorp.example>
Subject: Project Atlas Kickoff Meeting
Date: Mon, 10 Mar 2025 09:00:00 +0000

Hi Bob,

I wanted to confirm the details for the Atlas Kickoff Meeting scheduled for
next Friday. As the lead on Project Atlas, I'll be presenting the roadmap and
the Q3 Budget Review slides.

Could you please prepare a summary of your contributions so far?

Thanks,
Alice Nakamura
Acme Corp
`,
  },
  {
    relativePath: "emails/002-budget-review-notes.txt",
    content: `From: Bob Chen <bob@acmecorp.example>
To: Alice Nakamura <alice@acmecorp.example>, Carol Osei <carol@betaworks.example>
Subject: RE: Q3 Budget Review — notes
Date: Tue, 11 Mar 2025 14:30:00 +0000

Hi Alice, Carol,

Attaching my notes from the Q3 budget review discussion. Carol, since
Betaworks Ltd is a partner on Project Atlas, I thought it would be useful
to loop you in.

Key points:
- Atlas is on track for the Q3 milestone
- Onboarding of new team members starts next week

Best,
Bob Chen
Acme Corp
`,
  },
  {
    relativePath: "emails/003-onboarding-schedule.txt",
    content: `From: Carol Osei <carol@betaworks.example>
To: Bob Chen <bob@acmecorp.example>
Subject: Onboarding schedule for Atlas contributors
Date: Wed, 12 Mar 2025 10:15:00 +0000

Bob,

Thanks for the heads-up. Betaworks Ltd will have two engineers joining the
Project Atlas onboarding next week. Please share the onboarding materials
with them beforehand.

Regards,
Carol Osei
Betaworks Ltd
`,
  },
];

export const emailFixture: FixtureGenerator = {
  id: "inbox-email-v1",
  description: "Synthetic three-email inbox spanning two organisations and one shared project.",

  generate(): FixtureOutput {
    return {
      id: "inbox-email-v1",
      description: emailFixture.description,
      files: EMAIL_FILES,
      goldGraph: EMAIL_GOLD_GRAPH,
    };
  },
};
