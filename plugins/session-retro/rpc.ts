import { Rpc } from "@opencode/plugin/rpc";

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

const empty = { type: "object", additionalProperties: false } as const;

export const POLICIES = ["always", "never", "ask"] as const;
export type Policy = (typeof POLICIES)[number];

export type PendingSession = {
  sessionID: string;
  title: string;
  projectDir: string;
  turns: number;
  dueAt: number;
};

export type DueEvent = {
  sessionID: string;
  title: string;
  projectDir: string;
  turns: number;
  idleMinutes: number;
};

export const SessionRetro = Rpc.define({
  id: "session-retro",
  methods: {
    run: {
      input: sessionInput,
      output: {
        type: "object",
        properties: {
          runID: { type: "string" },
          ranAt: { type: "number" },
          findings: { type: "number" },
          report: { type: "string" },
        },
        required: ["runID", "ranAt", "findings", "report"],
        additionalProperties: false,
      },
      errors: {
        analysis_failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
    skip: { input: sessionInput, output: empty },
    later: { input: sessionInput, output: empty },
    policy: {
      input: {
        type: "object",
        properties: {
          projectDir: { type: "string" },
          policy: { type: "string", enum: [...POLICIES] },
        },
        required: ["projectDir", "policy"],
        additionalProperties: false,
      },
      output: empty,
    },
    pending: {
      input: empty,
      output: {
        type: "object",
        properties: {
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sessionID: { type: "string" },
                title: { type: "string" },
                projectDir: { type: "string" },
                turns: { type: "number" },
                dueAt: { type: "number" },
              },
              required: ["sessionID", "title", "projectDir", "turns", "dueAt"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
    settings: {
      input: sessionInput,
      output: {
        type: "object",
        properties: {
          projectDir: { type: "string" },
          policy: { type: "string", enum: [...POLICIES] },
          idleMinutes: { type: "number" },
          dbPath: { type: "string" },
        },
        required: ["projectDir", "policy", "idleMinutes", "dbPath"],
        additionalProperties: false,
      },
    },
  },
  events: {
    due: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          title: { type: "string" },
          projectDir: { type: "string" },
          turns: { type: "number" },
          idleMinutes: { type: "number" },
        },
        required: ["sessionID", "title", "projectDir", "turns", "idleMinutes"],
        additionalProperties: false,
      },
    },
  },
});
