import type { TutorMode } from "@copilot/shared";

/**
 * What each tutor mode changes about the reply. These are the real behavioural switches:
 * the UI buttons only choose a mode id; the instructions below are applied server-side.
 */
export const MODE_INSTRUCTIONS: Record<TutorMode, string> = {
  explain_simply:
    "Explain the topic at a noticeably easier level than before. Use everyday words, short sentences and one concrete analogy. Avoid jargon; if a technical term is unavoidable, define it in plain words first. Keep it brief, then check understanding with one easy question.",
  step_by_step:
    "Walk through the reasoning as a numbered sequence of small steps. State what you do in each step and why. Do not skip steps that a learner might find non-obvious. End with a one-line recap of the method so the student can reuse it.",
  example:
    "Give one concrete, worked example (or two short ones if they illustrate different cases). Show the working, then point out what the example demonstrates. Ask whether the student wants to try a similar one themselves.",
  hint:
    "Do NOT give the full answer or the final result. Give one small hint that moves the student forward, or a guiding question. Invite them to try the next step and say you will give another hint if they are stuck.",
  test_me:
    "Do NOT explain or give the answer. Ask the student ONE appropriate question about the current topic (or the most recent material), pitched at their level, and wait for their attempt. Keep the question self-contained. After they answer in a later message, give specific feedback.",
  summarize:
    "Summarize the key points of this conversation so far (or the subject/topic if the conversation is new) as a short bulleted list with definitions of key terms. Finish with the one idea the student most needs to remember.",
  find_mistake:
    "The student has shared their own working or answer. Find the specific mistake. First point to where it goes wrong WITHOUT giving the corrected solution, explain why it is wrong, and let them try the fix. If their work is actually correct, say so and explain why. If you cannot see any working in their message, ask them to paste it.",
  follow_up:
    "Ask the student one or two thoughtful follow-up questions that check real understanding of what was just discussed (not trivia), pitched slightly beyond recall. Do not answer them yourself.",
};

export const DEFAULT_MODE_GUIDANCE =
  "No special mode. Answer helpfully as a tutor: explain clearly, then encourage the student to try or reflect. Prefer asking the student to attempt a problem before revealing a full solution when they are working on an exercise.";
