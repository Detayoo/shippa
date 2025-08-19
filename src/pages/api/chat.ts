import type { NextApiRequest, NextApiResponse } from "next";
import { google } from "@ai-sdk/google";
import { streamText, UIMessage, convertToModelMessages, stepCountIs } from "ai";

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).end("Method Not Allowed");
    return;
  }

  const { messages }: { messages: UIMessage[] } = req.body;
  const STEP_COUNT = 5;

  const result = streamText({
    model: google("gemini-1.5-flash"),
    stopWhen: stepCountIs(STEP_COUNT),
    messages: convertToModelMessages(messages),
  });

  result.pipeUIMessageStreamToResponse(res);
};

export default handler;
