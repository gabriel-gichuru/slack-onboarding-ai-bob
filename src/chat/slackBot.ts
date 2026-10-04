import "dotenv/config";

/**

 * slackBot.ts

 *

 * Slack bot using Socket Mode (@slack/bolt).

 * Listens for app_mention events and runs the full onboarding pipeline:

 *

 *   answerQuestion → applyConfidenceGate → maybeEscalate

 *     → chainActions → recordAndGetTip → reply in thread

 *

 * ## Required environment variables

 *

 *   SLACK_BOT_TOKEN   — xoxb-... token (Bot Token, from OAuth & Permissions)

 *   SLACK_APP_TOKEN   — xapp-... token (App-Level Token, from Basic Information

 *                       with connections:write scope, required for Socket Mode)

 *

 * ## Optional environment variables (inherited from existing modules)

 *

 *   CHROMA_URL              — default: http://localhost:8000

 *   CONFIDENCE_THRESHOLD    — default: 0.65

 *   CONFIDENCE_DECAY_K      — default: 0.2877

 *   ESCALATION_LOG_PATH     — default: ./escalation.log

 *   PORT                    — not used by the bot; only by server.ts

 */



import { App, LogLevel } from "@slack/bolt";

import type { AppMentionEvent, Block, KnownBlock } from "@slack/types";

import type { SlackEventMiddlewareArgs } from "@slack/bolt";

import { answerQuestion } from "../answer/answerAgent.js";

import { applyConfidenceGate } from "../answer/confidenceGate.js";

import { chainActions } from "../actions/actionChainer.js";

import { maybeEscalate } from "../escalation/escalationLogger.js";

import { recordAndGetTip } from "../progress/sessionTracker.js";



// ── Helpers ────────────────────────────────────────────────────────────────



/**

 * Strip the @BotName mention from the start of the message text so the

 * question passed to answerQuestion is clean.

 *

 * Slack encodes mentions as `<@UXXXXXXXX>`, optionally followed by a space.

 */

function stripMention(text: string): string {

  return text.replace(/^<@[A-Z0-9]+>\s*/i, "").trim();

}



/**

 * Format the bot's reply as Slack Block Kit blocks so it renders cleanly

 * in the thread: 1. Detailed Answer -> 2. Suggested Actions -> 3. Confidence.

 */

function buildBlocks(

  answer: string,

  confidence: number,

  escalate: boolean,

  actions: Array<{ suggestion: string }>,

  mentorTip: { heading: string; body: string; exercise: string | null } | null

): (KnownBlock | Block)[] {

  const blocks: (KnownBlock | Block)[] = [];



  // Convert standard markdown **bold** to Slack mrkdwn *bold*

  const slackFormattedAnswer = answer.replace(/\*\*(.*?)\*\*/g, "*$1*");



  // ── 1. Detailed Human-Like Answer (First) ──────────────────────────────────

  blocks.push({

    type: "section",

    text: { type: "mrkdwn", text: slackFormattedAnswer },

  });



  // Optional: Interactive Mentor Tip / Exercise

  if (mentorTip) {

    blocks.push({ type: "divider" });

    blocks.push({

      type: "section",

      text: {

        type: "mrkdwn",

        text: `*${mentorTip.heading}*\n${mentorTip.body}`,

      },

    });

    if (mentorTip.exercise) {

      blocks.push({

        type: "section",

        text: { type: "mrkdwn", text: `📝 *${mentorTip.exercise}*` },

      });

    }

  }



  // ── 2. Suggested Actions (Second) ──────────────────────────────────────────

  if (actions.length > 0) {

    blocks.push({ type: "divider" });

    blocks.push({

      type: "section",

      text: {

        type: "mrkdwn",

        text:

          "*💬 Suggested actions:*\n" +

          actions.map((a) => `• ${a.suggestion}`).join("\n"),

      },

    });

  }



  // ── 3. Retrieval Confidence Footer (Last) ──────────────────────────────────

  const confidencePct = (confidence * 100).toFixed(0);

  const escalationNote = escalate

    ? "  ⚠️ *Low confidence* — please verify with a human mentor."

    : "";

  blocks.push({

    type: "context",

    elements: [

      {

        type: "mrkdwn",

        text: `🔍 *Retrieval Confidence:* ${confidencePct}%${escalationNote}`,

      },

    ],

  });



  return blocks;

}



// ── App setup ──────────────────────────────────────────────────────────────



const SLACK_BOT_TOKEN = process.env["SLACK_BOT_TOKEN"];

const SLACK_APP_TOKEN = process.env["SLACK_APP_TOKEN"];



if (!SLACK_BOT_TOKEN) throw new Error("Missing required env var: SLACK_BOT_TOKEN");

if (!SLACK_APP_TOKEN) throw new Error("Missing required env var: SLACK_APP_TOKEN");



const app = new App({

  token: SLACK_BOT_TOKEN,

  appToken: SLACK_APP_TOKEN,

  socketMode: true,

  // Suppress the default "bolt" console noise in production; keep warnings.

  logLevel:

    process.env["NODE_ENV"] === "production" ? LogLevel.WARN : LogLevel.DEBUG,

});



// ── app_mention handler ────────────────────────────────────────────────────



app.event(

  "app_mention",

  async ({ event, say }: SlackEventMiddlewareArgs<"app_mention"> & { event: AppMentionEvent }) => {

    const question = stripMention(event.text);



    if (!question) {

      await say({

        text: "Hi! Ask me anything about the codebase. Just mention me with a question.",

        thread_ts: event.ts,

      });

      return;

    }



    // Use the Slack user ID as the session ID so progress is tracked per-user

    // across all the channels they interact with the bot in.

    const sessionId = event.user ?? event.ts;



    // ── Pipeline ───────────────────────────────────────────────────────────

    let agentResult;

    try {

      agentResult = await answerQuestion(question);

    } catch (err) {

      console.error("[slackBot] answerQuestion failed:", err);

      await say({

        text: "⚠️ Sorry, I couldn't reach the knowledge base right now. Please try again shortly.",

        thread_ts: event.ts,

      });

      return;

    }



    const gated = applyConfidenceGate(agentResult);

    maybeEscalate(gated);

    const chained = chainActions(gated);



    const sourceNames = gated.sources.map((s) => s.source);

    const { mentorTip } = recordAndGetTip(sessionId, sourceNames, question);



    // ── Reply in thread ────────────────────────────────────────────────────

    // thread_ts: if the mention was already inside a thread, reply there;

    // otherwise start a new thread off the mention message.

    const thread_ts = event.thread_ts ?? event.ts;



    await say({

      thread_ts,

      text: gated.answer, // plain-text fallback for notifications

      blocks: buildBlocks(

        gated.answer,

        gated.confidence,

        gated.escalate,

        chained.actions,

        mentorTip

      ),

    });

  }

);



// ── Start ──────────────────────────────────────────────────────────────────



app.start().then(() => {

  console.log("⚡ Onboarding Slack bot connected via Socket Mode");

});
