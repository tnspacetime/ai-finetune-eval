/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Context, Effect, Layer } from "effect";

const exec = promisify(execCallback);

// -----------------------------------------------------------------------------
// Domain
// -----------------------------------------------------------------------------

type Session = {
  id: string;
  createdAt: number;
};

type PromptInput = {
  id: string;
  sessionId: string;
  prompt: string;
  delivery: PromptDelivery;
  admittedSeq: number;
  promotedSeq: number | null;
};

type PromptDelivery = "steer" | "queue";

type ProviderOutputItem = Record<string, unknown> & {
  id: string;
  type: string;
};

type ToolCall = {
  assistantMessageId: string;
  itemId: string;
  outputIndex: number;
  callId: string;
  name: string;
  arguments: string;
  providerItem: ProviderOutputItem;
};

type DurableEvent =
  | {
      type: "PromptAdmitted";
      inputId: string;
      prompt: string;
      delivery: PromptDelivery;
    }
  | {
      type: "Prompted";
      inputId: string;
      prompt: string;
    }
  | { type: "StepStarted"; assistantMessageId: string }
  | {
      type: "OutputItemCompleted";
      assistantMessageId: string;
      outputIndex: number;
      item: ProviderOutputItem;
    }
  | {
      type: "ToolCalled";
      assistantMessageId: string;
      itemId: string;
      outputIndex: number;
      callId: string;
      name: string;
      arguments: string;
      providerItem: ProviderOutputItem;
    }
  | {
      type: "ToolSettled";
      assistantMessageId: string;
      callId: string;
      output: string;
      isError: boolean;
    }
  | { type: "StepCompleted"; assistantMessageId: string; responseId: string }
  | { type: "StepFailed"; assistantMessageId: string; error: string };

type StoredEvent = {
  sessionId: string;
  seq: number;
  event: DurableEvent;
  createdAt: number;
};

type ModelInputItem = Record<string, unknown>;

type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type LLMEvent =
  | { type: "text-delta"; delta: string }
  | { type: "output-item"; outputIndex: number; item: ProviderOutputItem }
  | { type: "tool-call"; call: ToolCall }
  | { type: "completed"; responseId: string };

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const attempt = <A>(f: () => A): Effect.Effect<A, Error> =>
  Effect.try({ try: f, catch: asError });

const attemptPromise = <A>(f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: f, catch: asError });

const clip = (text: string, max = 40_000) =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;

// -----------------------------------------------------------------------------
// Database service
// -----------------------------------------------------------------------------

namespace Database {
  export interface Interface {
    readonly raw: DatabaseSync;
  }

  export class Service extends Context.Service<Service, Interface>()(
    "mini-v2/Database",
  ) {}

  export const layer = (path: string) =>
    Layer.effect(
      Service,
      Effect.acquireRelease(
        Effect.sync(() => {
          const raw = new DatabaseSync(path);
          raw.exec("PRAGMA journal_mode = WAL");
          raw.exec("PRAGMA foreign_keys = ON");
          raw.exec("PRAGMA busy_timeout = 5000");
          return { raw } satisfies Interface;
        }),
        ({ raw }) => Effect.sync(() => raw.close()),
      ),
    );
}

// -----------------------------------------------------------------------------
// SessionStore
// -----------------------------------------------------------------------------

namespace SessionStore {
  export interface Interface {
    readonly create: (id?: string) => Effect.Effect<Session, Error>;
    readonly get: (sessionId: string) => Effect.Effect<Session, Error>;
    readonly admit: (input: {
      id?: string;
      sessionId: string;
      prompt: string;
      delivery: PromptDelivery;
    }) => Effect.Effect<{ inputId: string; admittedSeq: number }, Error>;
    readonly pending: (
      sessionId: string,
      delivery: PromptDelivery,
      limit?: number,
    ) => Effect.Effect<readonly PromptInput[], Error>;
    readonly promote: (input: PromptInput) => Effect.Effect<number, Error>;
    readonly append: (
      sessionId: string,
      event: DurableEvent,
    ) => Effect.Effect<number, Error>;
    readonly modelHistory: (
      sessionId: string,
    ) => Effect.Effect<ModelInputItem[], Error>;
    readonly events: (sessionId: string) => Effect.Effect<StoredEvent[], Error>;
    readonly recoverInterrupted: (
      sessionId: string,
    ) => Effect.Effect<{ tools: number; steps: number }, Error>;
    readonly rebuildProjections: (
      sessionId: string,
    ) => Effect.Effect<void, Error>;
    readonly projectedState: (
      sessionId: string,
    ) => Effect.Effect<unknown, Error>;
  }

  export class Service extends Context.Service<Service, Interface>()(
    "mini-v2/SessionStore",
  ) {}

  type EventRow = {
    session_id: string;
    seq: number;
    type: string;
    payload_json: string;
    created_at: number;
  };

  function init(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_event (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES session(id)
      );

      CREATE TABLE IF NOT EXISTS session_input (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        delivery TEXT NOT NULL CHECK(delivery IN ('steer', 'queue')),
        admitted_seq INTEGER NOT NULL,
        promoted_seq INTEGER,
        FOREIGN KEY (session_id) REFERENCES session(id)
      );

      CREATE INDEX IF NOT EXISTS session_input_pending
        ON session_input(session_id, promoted_seq, admitted_seq);

      CREATE TABLE IF NOT EXISTS message (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (session_id, id),
        FOREIGN KEY (session_id) REFERENCES session(id)
      );

      CREATE INDEX IF NOT EXISTS message_session_seq
        ON message(session_id, seq);

      CREATE TABLE IF NOT EXISTS assistant_step (
        session_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        started_seq INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        finish_seq INTEGER,
        response_id TEXT,
        error TEXT,
        PRIMARY KEY (session_id, assistant_message_id),
        FOREIGN KEY (session_id) REFERENCES session(id)
      );

      CREATE INDEX IF NOT EXISTS assistant_step_session_started
        ON assistant_step(session_id, started_seq);

      CREATE TABLE IF NOT EXISTS provider_item (
        session_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        output_index INTEGER NOT NULL,
        item_json TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (session_id, assistant_message_id, item_id),
        FOREIGN KEY (session_id, assistant_message_id)
          REFERENCES assistant_step(session_id, assistant_message_id)
      );

      CREATE INDEX IF NOT EXISTS provider_item_step_order
        ON provider_item(session_id, assistant_message_id, output_index);

      CREATE TABLE IF NOT EXISTS tool_call (
        session_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        output_index INTEGER NOT NULL,
        call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        provider_item_json TEXT NOT NULL,
        call_seq INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        output TEXT,
        settle_seq INTEGER,
        PRIMARY KEY (session_id, assistant_message_id, call_id),
        FOREIGN KEY (session_id, assistant_message_id)
          REFERENCES assistant_step(session_id, assistant_message_id)
      );

      CREATE INDEX IF NOT EXISTS tool_call_session_call_seq
        ON tool_call(session_id, call_seq);
    `);
  }

  function inTransaction<A>(db: DatabaseSync, f: () => A): A {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  function nextSeq(db: DatabaseSync, sessionId: string): number {
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_event WHERE session_id = ?",
      )
      .get(sessionId) as { seq: number };
    return Number(row.seq);
  }

  function visibleAssistantText(item: ProviderOutputItem): string | undefined {
    if (item.type !== "message" || !Array.isArray(item.content))
      return undefined;
    const text = item.content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const value = part as Record<string, unknown>;
        return value.type === "output_text" || value.type === "refusal"
          ? String(value.text ?? value.refusal ?? "")
          : "";
      })
      .join("");
    return text || undefined;
  }

  function project(
    db: DatabaseSync,
    sessionId: string,
    seq: number,
    event: DurableEvent,
  ) {
    switch (event.type) {
      case "PromptAdmitted": {
        db.prepare(
          `
          INSERT INTO session_input(
            id, session_id, prompt, delivery, admitted_seq, promoted_seq
          ) VALUES (?, ?, ?, ?, ?, NULL)
        `,
        ).run(event.inputId, sessionId, event.prompt, event.delivery, seq);
        return;
      }

      case "Prompted": {
        // This is intentionally one event transaction:
        // visible user message + inbox promotion become true atomically.
        db.prepare(
          `
          INSERT INTO message(id, session_id, role, text, seq)
          VALUES (?, ?, 'user', ?, ?)
        `,
        ).run(event.inputId, sessionId, event.prompt, seq);

        const result = db
          .prepare(
            `
          UPDATE session_input
          SET promoted_seq = ?
          WHERE id = ? AND session_id = ? AND promoted_seq IS NULL
        `,
          )
          .run(seq, event.inputId, sessionId);

        if (Number(result.changes) !== 1) {
          throw new Error(
            `Prompted projector could not promote input ${event.inputId}`,
          );
        }
        return;
      }

      case "StepStarted": {
        db.prepare(
          `
          INSERT INTO assistant_step(
            session_id, assistant_message_id, started_seq,
            status, finish_seq, response_id, error
          ) VALUES (?, ?, ?, 'running', NULL, NULL, NULL)
        `,
        ).run(sessionId, event.assistantMessageId, seq);
        return;
      }

      case "OutputItemCompleted": {
        db.prepare(
          `
          INSERT INTO provider_item(
            session_id, assistant_message_id, item_id,
            output_index, item_json, seq
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        ).run(
          sessionId,
          event.assistantMessageId,
          event.item.id,
          event.outputIndex,
          JSON.stringify(event.item),
          seq,
        );

        const text = visibleAssistantText(event.item);
        if (text) {
          db.prepare(
            `
            INSERT INTO message(id, session_id, role, text, seq)
            VALUES (?, ?, 'assistant', ?, ?)
          `,
          ).run(event.item.id, sessionId, text, seq);
        }
        return;
      }

      case "ToolCalled": {
        db.prepare(
          `
          INSERT INTO tool_call(
            session_id, assistant_message_id, item_id, output_index,
            call_id, name, arguments, provider_item_json,
            call_seq, status, output, settle_seq
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL)
        `,
        ).run(
          sessionId,
          event.assistantMessageId,
          event.itemId,
          event.outputIndex,
          event.callId,
          event.name,
          event.arguments,
          JSON.stringify(event.providerItem),
          seq,
        );
        return;
      }

      case "ToolSettled": {
        const result = db
          .prepare(
            `
          UPDATE tool_call
          SET status = ?, output = ?, settle_seq = ?
          WHERE session_id = ?
            AND assistant_message_id = ?
            AND call_id = ?
            AND status = 'running'
        `,
          )
          .run(
            event.isError ? "failed" : "completed",
            event.output,
            seq,
            sessionId,
            event.assistantMessageId,
            event.callId,
          );

        if (Number(result.changes) !== 1) {
          throw new Error(
            `ToolSettled projector could not settle ${event.assistantMessageId}/${event.callId}`,
          );
        }
        return;
      }

      case "StepCompleted": {
        const result = db
          .prepare(
            `
          UPDATE assistant_step
          SET status = 'completed', finish_seq = ?, response_id = ?, error = NULL
          WHERE session_id = ? AND assistant_message_id = ? AND status = 'running'
        `,
          )
          .run(seq, event.responseId, sessionId, event.assistantMessageId);
        if (Number(result.changes) !== 1) {
          throw new Error(
            `StepCompleted could not finish ${event.assistantMessageId}`,
          );
        }
        return;
      }

      case "StepFailed": {
        const result = db
          .prepare(
            `
          UPDATE assistant_step
          SET status = 'failed', finish_seq = ?, error = ?, response_id = NULL
          WHERE session_id = ? AND assistant_message_id = ? AND status = 'running'
        `,
          )
          .run(seq, event.error, sessionId, event.assistantMessageId);
        if (Number(result.changes) !== 1) {
          throw new Error(
            `StepFailed could not finish ${event.assistantMessageId}`,
          );
        }
        return;
      }
    }
  }

  function appendSync(
    db: DatabaseSync,
    sessionId: string,
    event: DurableEvent,
  ): number {
    return inTransaction(db, () => {
      const exists = db
        .prepare("SELECT id FROM session WHERE id = ?")
        .get(sessionId);
      if (!exists) throw new Error(`Session not found: ${sessionId}`);

      const seq = nextSeq(db, sessionId);
      const createdAt = Date.now();
      const { type, ...payload } = event;

      db.prepare(
        `
        INSERT INTO session_event(session_id, seq, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      ).run(sessionId, seq, type, JSON.stringify(payload), createdAt);

      project(db, sessionId, seq, event);
      return seq;
    });
  }

  function parseEvent(row: EventRow): StoredEvent {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    return {
      sessionId: row.session_id,
      seq: Number(row.seq),
      createdAt: Number(row.created_at),
      event: { type: row.type, ...payload } as DurableEvent,
    };
  }

  function make(db: DatabaseSync): Interface {
    init(db);

    const append: Interface["append"] = (sessionId, event) =>
      attempt(() => appendSync(db, sessionId, event));

    return {
      create: (requestedId) =>
        attempt(() => {
          const id = requestedId ?? randomUUID();
          const existing = db
            .prepare("SELECT id, created_at FROM session WHERE id = ?")
            .get(id) as { id: string; created_at: number } | undefined;

          if (existing)
            return { id: existing.id, createdAt: Number(existing.created_at) };

          const createdAt = Date.now();
          db.prepare("INSERT INTO session(id, created_at) VALUES (?, ?)").run(
            id,
            createdAt,
          );
          return { id, createdAt };
        }),

      get: (sessionId) =>
        attempt(() => {
          const row = db
            .prepare("SELECT id, created_at FROM session WHERE id = ?")
            .get(sessionId) as { id: string; created_at: number } | undefined;
          if (!row) throw new Error(`Session not found: ${sessionId}`);
          return { id: row.id, createdAt: Number(row.created_at) };
        }),

      admit: ({ id: requestedId, sessionId, prompt, delivery }) =>
        attempt(() => {
          const inputId = requestedId ?? randomUUID();
          const existing = db
            .prepare(
              `
            SELECT id, session_id, prompt, delivery, admitted_seq
            FROM session_input
            WHERE id = ?
          `,
            )
            .get(inputId) as
            | {
                id: string;
                session_id: string;
                prompt: string;
                delivery: PromptDelivery;
                admitted_seq: number;
              }
            | undefined;

          if (existing) {
            if (
              existing.session_id !== sessionId ||
              existing.prompt !== prompt ||
              existing.delivery !== delivery
            ) {
              throw new Error(
                `Input Id ${inputId} was already used for different admission data`,
              );
            }
            return { inputId, admittedSeq: Number(existing.admitted_seq) };
          }

          const admittedSeq = appendSync(db, sessionId, {
            type: "PromptAdmitted",
            inputId,
            prompt,
            delivery,
          });
          return { inputId, admittedSeq };
        }),

      pending: (sessionId, delivery, limit) =>
        attempt(() => {
          const rows = db
            .prepare(
              `
            SELECT id, session_id, prompt, delivery, admitted_seq, promoted_seq
            FROM session_input
            WHERE session_id = ? AND delivery = ? AND promoted_seq IS NULL
            ORDER BY admitted_seq ASC
            LIMIT ?
          `,
            )
            .all(sessionId, delivery, limit ?? -1) as Array<{
            id: string;
            session_id: string;
            prompt: string;
            delivery: PromptDelivery;
            admitted_seq: number;
            promoted_seq: number | null;
          }>;

          return rows.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            prompt: row.prompt,
            delivery: row.delivery,
            admittedSeq: Number(row.admitted_seq),
            promotedSeq:
              row.promoted_seq == null ? null : Number(row.promoted_seq),
          }));
        }),

      promote: (input) =>
        append(input.sessionId, {
          type: "Prompted",
          inputId: input.id,
          prompt: input.prompt,
        }),

      append,

      modelHistory: (sessionId) =>
        attempt(() => {
          type Timeline = {
            seq: number;
            phase: number;
            order: number;
            value: ModelInputItem;
          };
          const timeline: Timeline[] = [];

          const users = db
            .prepare(
              `
            SELECT text, seq
            FROM message
            WHERE session_id = ? AND role = 'user'
          `,
            )
            .all(sessionId) as Array<{ text: string; seq: number }>;

          for (const row of users) {
            timeline.push({
              seq: Number(row.seq),
              phase: 0,
              order: 0,
              value: { role: "user", content: row.text },
            });
          }

          const steps = db
            .prepare(
              `
            SELECT assistant_message_id, started_seq
            FROM assistant_step
            WHERE session_id = ?
          `,
            )
            .all(sessionId) as Array<{
            assistant_message_id: string;
            started_seq: number;
          }>;

          for (const step of steps) {
            const outputs = db
              .prepare(
                `
              SELECT output_index, item_json
              FROM provider_item
              WHERE session_id = ? AND assistant_message_id = ?
              UNION ALL
              SELECT output_index, provider_item_json AS item_json
              FROM tool_call
              WHERE session_id = ? AND assistant_message_id = ?
              ORDER BY output_index ASC
            `,
              )
              .all(
                sessionId,
                step.assistant_message_id,
                sessionId,
                step.assistant_message_id,
              ) as Array<{ output_index: number; item_json: string }>;

            for (const output of outputs) {
              timeline.push({
                seq: Number(step.started_seq),
                phase: 1,
                order: Number(output.output_index),
                value: JSON.parse(output.item_json) as ModelInputItem,
              });
            }

            const results = db
              .prepare(
                `
              SELECT call_id, status, output, settle_seq
              FROM tool_call
              WHERE session_id = ?
                AND assistant_message_id = ?
                AND settle_seq IS NOT NULL
              ORDER BY settle_seq ASC
            `,
              )
              .all(sessionId, step.assistant_message_id) as Array<{
              call_id: string;
              status: "completed" | "failed";
              output: string;
              settle_seq: number;
            }>;

            for (const result of results) {
              timeline.push({
                seq: Number(step.started_seq),
                phase: 2,
                order: Number(result.settle_seq),
                value: {
                  type: "function_call_output",
                  call_id: result.call_id,
                  output:
                    result.status === "failed"
                      ? `ERROR: ${result.output}`
                      : result.output,
                },
              });
            }
          }

          timeline.sort(
            (a, b) => a.seq - b.seq || a.phase - b.phase || a.order - b.order,
          );
          return timeline.map((item) => item.value);
        }),

      events: (sessionId) =>
        attempt(() => {
          const rows = db
            .prepare(
              `
            SELECT session_id, seq, type, payload_json, created_at
            FROM session_event
            WHERE session_id = ?
            ORDER BY seq ASC
          `,
            )
            .all(sessionId) as EventRow[];
          return rows.map(parseEvent);
        }),

      recoverInterrupted: (sessionId) =>
        attempt(() => {
          const tools = db
            .prepare(
              `
            SELECT assistant_message_id, call_id
            FROM tool_call
            WHERE session_id = ? AND status = 'running'
            ORDER BY call_seq ASC
          `,
            )
            .all(sessionId) as Array<{
            assistant_message_id: string;
            call_id: string;
          }>;

          for (const row of tools) {
            appendSync(db, sessionId, {
              type: "ToolSettled",
              assistantMessageId: row.assistant_message_id,
              callId: row.call_id,
              output: "Tool execution interrupted by previous process",
              isError: true,
            });
          }

          const steps = db
            .prepare(
              `
            SELECT assistant_message_id
            FROM assistant_step
            WHERE session_id = ? AND status = 'running'
            ORDER BY started_seq ASC
          `,
            )
            .all(sessionId) as Array<{ assistant_message_id: string }>;

          for (const row of steps) {
            appendSync(db, sessionId, {
              type: "StepFailed",
              assistantMessageId: row.assistant_message_id,
              error: "Provider turn interrupted by previous process",
            });
          }

          return { tools: tools.length, steps: steps.length };
        }),

      rebuildProjections: (sessionId) =>
        attempt(() => {
          inTransaction(db, () => {
            db.prepare("DELETE FROM provider_item WHERE session_id = ?").run(
              sessionId,
            );
            db.prepare("DELETE FROM tool_call WHERE session_id = ?").run(
              sessionId,
            );
            db.prepare("DELETE FROM message WHERE session_id = ?").run(
              sessionId,
            );
            db.prepare("DELETE FROM assistant_step WHERE session_id = ?").run(
              sessionId,
            );
            db.prepare("DELETE FROM session_input WHERE session_id = ?").run(
              sessionId,
            );

            const rows = db
              .prepare(
                `
              SELECT session_id, seq, type, payload_json, created_at
              FROM session_event
              WHERE session_id = ?
              ORDER BY seq ASC
            `,
              )
              .all(sessionId) as EventRow[];

            for (const row of rows) {
              const stored = parseEvent(row);
              project(db, sessionId, stored.seq, stored.event);
            }
          });
        }),

      projectedState: (sessionId) =>
        attempt(() => {
          const inbox = db
            .prepare(
              `
            SELECT id, prompt, delivery, admitted_seq, promoted_seq
            FROM session_input WHERE session_id = ? ORDER BY admitted_seq
          `,
            )
            .all(sessionId);

          const messages = db
            .prepare(
              `
            SELECT id, role, text, seq
            FROM message WHERE session_id = ? ORDER BY seq
          `,
            )
            .all(sessionId);

          const steps = db
            .prepare(
              `
            SELECT assistant_message_id, started_seq, status,
                   finish_seq, response_id, error
            FROM assistant_step WHERE session_id = ? ORDER BY started_seq
          `,
            )
            .all(sessionId);

          const providerItems = db
            .prepare(
              `
            SELECT assistant_message_id, item_id, output_index, item_json, seq
            FROM provider_item
            WHERE session_id = ?
            ORDER BY seq
          `,
            )
            .all(sessionId);

          const tools = db
            .prepare(
              `
            SELECT assistant_message_id, item_id, output_index,
                   call_id, name, arguments, call_seq,
                   status, output, settle_seq
            FROM tool_call WHERE session_id = ? ORDER BY call_seq
          `,
            )
            .all(sessionId);

          return { inbox, messages, steps, providerItems, tools };
        }),
    };
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service;
      return make(database.raw);
    }),
  );
}

// -----------------------------------------------------------------------------
// ToolRegistry
// -----------------------------------------------------------------------------

namespace ToolRegistry {
  export interface Interface {
    readonly definitions: readonly ToolDefinition[];
    readonly execute: (
      name: string,
      argsJSON: string,
      signal: AbortSignal,
    ) => Promise<{ output: string; isError: boolean }>;
  }

  export class Service extends Context.Service<Service, Interface>()(
    "mini-v2/ToolRegistry",
  ) {}

  function safePath(root: string, requested: string): string {
    const absolute = resolve(root, requested);
    const rel = relative(root, absolute);
    if (
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      throw new Error(`Path escapes harness root: ${requested}`);
    }
    return absolute;
  }

  export const layer = (rootInput: string) => {
    const root = resolve(rootInput);

    const definitions: readonly ToolDefinition[] = [
      {
        name: "read",
        description: "Read a UTF-8 text file inside the repository root.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "write",
        description:
          "Write a complete UTF-8 text file inside the repository root.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      {
        name: "bash",
        description:
          "Run a shell command in the repository root and return stdout/stderr.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      },
    ];

    const executeTool: Interface["execute"] = async (
      name,
      argsJSON,
      signal,
    ) => {
      try {
        const args = JSON.parse(argsJSON) as Record<string, unknown>;

        if (name === "read") {
          const path = safePath(root, String(args.path ?? ""));
          return {
            output: clip(await readFile(path, { encoding: "utf8", signal })),
            isError: false,
          };
        }

        if (name === "write") {
          const path = safePath(root, String(args.path ?? ""));
          const content = String(args.content ?? "");
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content, { encoding: "utf8", signal });
          return {
            output: `Wrote ${Buffer.byteLength(content)} bytes to ${relative(root, path)}`,
            isError: false,
          };
        }

        if (name === "bash") {
          const command = String(args.command ?? "");
          const result = await exec(command, {
            cwd: root,
            signal,
            maxBuffer: 2 * 1024 * 1024,
          });
          const text = [result.stdout, result.stderr]
            .filter(Boolean)
            .join("\n");
          return {
            output: clip(text || "(command produced no output)"),
            isError: false,
          };
        }

        return { output: `Unknown tool: ${name}`, isError: true };
      } catch (error) {
        return { output: asError(error).message, isError: true };
      }
    };

    return Layer.succeed(Service, { definitions, execute: executeTool });
  };
}

// -----------------------------------------------------------------------------
// LLM service
// -----------------------------------------------------------------------------

namespace LLM {
  export interface StreamInput {
    readonly history: readonly ModelInputItem[];
    readonly tools: readonly ToolDefinition[];
    readonly assistantMessageId: string;
    readonly signal: AbortSignal;
  }

  export interface Interface {
    readonly stream: (input: StreamInput) => AsyncIterable<LLMEvent>;
  }

  export class Service extends Context.Service<Service, Interface>()(
    "mini-v2/LLM",
  ) {}

  async function* sseJSON(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<any> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const dataOf = (block: string): string | undefined => {
      const lines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      return lines.length === 0 ? undefined : lines.join("\n");
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder
          .decode(value, { stream: true })
          .replaceAll("\r\n", "\n");

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = dataOf(block);
          if (!data) continue;
          if (data === "[DONE]") return;
          yield JSON.parse(data);
        }
      }

      const trailing = dataOf(buffer);
      if (trailing && trailing !== "[DONE]") yield JSON.parse(trailing);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed or failed.
      }
      reader.releaseLock();
    }
  }

  export const layer = (config: {
    apiKey: string;
    model: string;
    baseURL: string;
  }) =>
    Layer.succeed(Service, {
      stream: async function* ({ history, tools, assistantMessageId, signal }) {
        const response = await fetch(
          `${config.baseURL.replace(/\/$/, "")}/responses`,
          {
            method: "POST",
            signal,
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: config.model,
              instructions: [
                "You are a coding agent operating inside a repository.",
                "Use tools when needed. Inspect before editing. Keep changes focused.",
                "After tool results arrive, continue until the user's task is complete.",
              ].join("\n"),
              input: history,
              tools: tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: true,
              })),
              tool_choice: "auto",
              store: false,
              include: ["reasoning.encrypted_content"],
              stream: true,
            }),
          },
        );

        if (!response.ok) {
          throw new Error(
            `LLM HTTP ${response.status}: ${await response.text()}`,
          );
        }
        if (!response.body)
          throw new Error("LLM response did not contain a stream body");

        let completed = false;
        for await (const event of sseJSON(response.body)) {
          if (
            (event.type === "response.output_text.delta" ||
              event.type === "response.refusal.delta") &&
            typeof event.delta === "string"
          ) {
            yield { type: "text-delta", delta: event.delta } satisfies LLMEvent;
            continue;
          }

          if (event.type === "response.output_item.done") {
            if (typeof event.item !== "object" || event.item === null) {
              throw new Error(
                "Provider completed an output item without an item payload",
              );
            }

            const item = event.item as ProviderOutputItem;
            if (typeof item.id !== "string" || typeof item.type !== "string") {
              throw new Error(
                "Provider completed an output item without stable identity",
              );
            }
            const outputIndex = Number(event.output_index);
            if (!Number.isInteger(outputIndex) || outputIndex < 0) {
              throw new Error(
                `Invalid provider output index: ${event.output_index}`,
              );
            }

            if (item.type === "function_call") {
              if (
                typeof item.call_id !== "string" ||
                typeof item.name !== "string"
              ) {
                throw new Error(`Invalid function call item: ${item.id}`);
              }
              yield {
                type: "tool-call",
                call: {
                  assistantMessageId,
                  itemId: item.id,
                  outputIndex,
                  callId: item.call_id,
                  name: item.name,
                  arguments: String(item.arguments ?? "{}"),
                  providerItem: item,
                },
              } satisfies LLMEvent;
              continue;
            }

            yield { type: "output-item", outputIndex, item } satisfies LLMEvent;
            continue;
          }

          if (event.type === "response.completed") {
            const responseId = String(event.response?.id ?? "");
            if (!responseId)
              throw new Error("Completed provider response had no Id");
            completed = true;
            yield { type: "completed", responseId } satisfies LLMEvent;
            continue;
          }

          if (event.type === "response.incomplete") {
            const reason =
              event.response?.incomplete_details?.reason ?? "unknown reason";
            throw new Error(`Provider response incomplete: ${reason}`);
          }

          if (event.type === "response.failed") {
            throw new Error(
              event.response?.error?.message ?? "Provider response failed",
            );
          }

          if (event.type === "error") {
            throw new Error(
              event.error?.message ?? event.message ?? "Provider stream error",
            );
          }
        }

        if (!completed)
          throw new Error("Provider stream ended before response.completed");
      },
    });
}

// -----------------------------------------------------------------------------
// SessionRunner
// -----------------------------------------------------------------------------

namespace SessionRunner {
  export interface Interface {
    readonly run: (input: {
      sessionId: string;
      force: boolean;
      signal: AbortSignal;
    }) => Effect.Effect<void, Error>;
  }

  export class Service extends Context.Service<Service, Interface>()(
    "mini-v2/SessionRunner",
  ) {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service;
      const llm = yield* LLM.Service;
      const tools = yield* ToolRegistry.Service;

      return {
        run: ({ sessionId, force, signal }) =>
          attemptPromise(async () => {
            const pending = (delivery: PromptDelivery, limit?: number) =>
              Effect.runPromise(store.pending(sessionId, delivery, limit));

            const promote = async (
              delivery: PromptDelivery,
            ): Promise<number> => {
              const inputs = await pending(
                delivery,
                delivery === "queue" ? 1 : undefined,
              );
              for (const input of inputs)
                await Effect.runPromise(store.promote(input));
              return inputs.length;
            };

            // A wake only runs when it can promote work. Explicit run(force=true)
            // deliberately resumes from already-projected durable history.
            const hasSteer = (await pending("steer", 1)).length > 0;
            const hasQueue = hasSteer
              ? false
              : (await pending("queue", 1)).length > 0;
            if (!force && !hasSteer && !hasQueue) return;

            // Running state belongs to a lost process. Preserve what is known,
            // fail what is ambiguous, and never replay external side effects.
            const recovered = await Effect.runPromise(
              store.recoverInterrupted(sessionId),
            );
            if (recovered.tools > 0 || recovered.steps > 0) {
              console.log(
                `\n[recovery] interrupted ${recovered.tools} tool(s), ${recovered.steps} step(s)`,
              );
            }

            let promoted = await promote("steer");
            if (promoted === 0) promoted = await promote("queue");

            let history = await Effect.runPromise(
              store.modelHistory(sessionId),
            );
            if (history.length === 0) return;

            // A drain may contain multiple provider turns because tools create
            // required continuation and steers enter at safe boundaries.
            while (!signal.aborted) {
              const assistantMessageId = randomUUID();
              let stepStarted = false;
              let responseId: string | undefined;
              let wroteText = false;
              let textEndedWithNewline = true;
              const startStep = async () => {
                if (stepStarted) return;
                await Effect.runPromise(
                  store.append(sessionId, {
                    type: "StepStarted",
                    assistantMessageId,
                  }),
                );
                stepStarted = true;
              };

              // Each child owns execution AND durable settlement. The promises
              // never reject early, so the parent can always wait for all cleanup.
              const settlements: Array<{
                call: ToolCall;
                settled: Promise<Error | undefined>;
              }> = [];

              let providerError: Error | undefined;

              try {
                for await (const event of llm.stream({
                  history,
                  tools: tools.definitions,
                  assistantMessageId,
                  signal,
                })) {
                  if (event.type === "text-delta") {
                    process.stdout.write(event.delta);
                    wroteText = true;
                    textEndedWithNewline = event.delta.endsWith("\n");
                    continue;
                  }

                  if (event.type === "output-item") {
                    await startStep();
                    await Effect.runPromise(
                      store.append(sessionId, {
                        type: "OutputItemCompleted",
                        assistantMessageId,
                        outputIndex: event.outputIndex,
                        item: event.item,
                      }),
                    );
                    continue;
                  }

                  if (event.type === "completed") {
                    responseId = event.responseId;
                    continue;
                  }

                  const call = event.call;
                  await startStep();

                  // This event/projected `running` tool exists durably BEFORE
                  // the external side effect starts.
                  await Effect.runPromise(
                    store.append(sessionId, {
                      type: "ToolCalled",
                      assistantMessageId: call.assistantMessageId,
                      itemId: call.itemId,
                      outputIndex: call.outputIndex,
                      callId: call.callId,
                      name: call.name,
                      arguments: call.arguments,
                      providerItem: call.providerItem,
                    }),
                  );

                  console.log(`\n[tool:${call.name}] ${call.arguments}`);
                  const settled = (async (): Promise<Error | undefined> => {
                    try {
                      const result = await tools.execute(
                        call.name,
                        call.arguments,
                        signal,
                      );
                      await Effect.runPromise(
                        store.append(sessionId, {
                          type: "ToolSettled",
                          assistantMessageId: call.assistantMessageId,
                          callId: call.callId,
                          output: result.output,
                          isError: result.isError,
                        }),
                      );
                      console.log(
                        `[tool:${call.name}] ${result.isError ? "ERROR" : "done"}`,
                      );
                      return undefined;
                    } catch (error) {
                      return asError(error);
                    }
                  })();
                  settlements.push({
                    call,
                    settled,
                  });
                }
              } catch (error) {
                providerError = asError(error);
              }

              if (wroteText && !textEndedWithNewline)
                process.stdout.write("\n");

              // All children have already attempted durable settlement; this is
              // only the continuation/cleanup barrier.
              const settlementErrors = await Promise.all(
                settlements.map((item) => item.settled),
              );
              const settlementError = settlementErrors.find(
                (error): error is Error => error !== undefined,
              );

              const failure =
                providerError ??
                settlementError ??
                (signal.aborted ? new Error("Session interrupted") : undefined);

              if (failure) {
                await startStep();
                await Effect.runPromise(
                  store.append(sessionId, {
                    type: "StepFailed",
                    assistantMessageId,
                    error: failure.message,
                  }),
                );
                throw failure;
              }

              if (!responseId)
                throw new Error("Provider completed without a response Id");
              await startStep();
              await Effect.runPromise(
                store.append(sessionId, {
                  type: "StepCompleted",
                  assistantMessageId,
                  responseId,
                }),
              );

              // Steers join the next required continuation. Queued prompts wait
              // until the current tool chain would otherwise become idle.
              const steers = await promote("steer");
              if (settlements.length > 0 || steers > 0) {
                // The v2 continuation boundary: reload PROJECTED durable history
                // once after tool settlement, then issue the next provider turn.
                history = await Effect.runPromise(
                  store.modelHistory(sessionId),
                );
                continue;
              }

              const queued = await promote("queue");
              if (queued === 0) return;
              history = await Effect.runPromise(store.modelHistory(sessionId));
            }

            throw new Error("Session interrupted");
          }),
      } satisfies Interface;
    }),
  );
}

// -----------------------------------------------------------------------------
// SessionRunCoordinator
// -----------------------------------------------------------------------------

namespace SessionRunCoordinator {
  export interface Interface {
    readonly wake: (sessionId: string) => Effect.Effect<void>;
    readonly run: (sessionId: string) => Effect.Effect<void, Error>;
    readonly interrupt: (sessionId: string) => Effect.Effect<void>;
    readonly active: () => Effect.Effect<readonly string[]>;
  }

  export class Service extends Context.Service<Service, Interface>()(
    "mini-v2/SessionRunCoordinator",
  ) {}

  type Slot = {
    controller: AbortController;
    promise: Promise<void>;
    followUpWake: boolean;
    stopping: boolean;
  };

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const runner = yield* SessionRunner.Service;
      const active = new Map<string, Slot>();

      const start = (sessionId: string, force: boolean): Promise<void> => {
        const existing = active.get(sessionId);
        if (existing) {
          if (!existing.stopping) return existing.promise;
          return existing.promise
            .catch(() => undefined)
            .then(() => start(sessionId, force));
        }

        const controller = new AbortController();
        const slot = {
          controller,
          promise: Promise.resolve(),
          followUpWake: false,
          stopping: false,
        } satisfies Slot;

        slot.promise = (async () => {
          let nextForce = force;
          do {
            slot.followUpWake = false;
            await Effect.runPromise(
              runner.run({
                sessionId,
                force: nextForce,
                signal: controller.signal,
              }),
            );
            nextForce = false;
          } while (!controller.signal.aborted && slot.followUpWake);
        })().finally(() => {
          if (active.get(sessionId) !== slot) return;
          active.delete(sessionId);
          if (slot.followUpWake) {
            void start(sessionId, false).catch((error) => {
              console.error(
                `\n[session ${sessionId}] ${asError(error).message}`,
              );
            });
          }
        });

        active.set(sessionId, slot);
        return slot.promise;
      };

      return {
        wake: (sessionId) =>
          Effect.sync(() => {
            const slot = active.get(sessionId);
            if (slot) {
              slot.followUpWake = true;
              return;
            }
            void start(sessionId, false).catch((error) => {
              console.error(
                `\n[session ${sessionId}] ${asError(error).message}`,
              );
            });
          }),

        run: (sessionId) => attemptPromise(() => start(sessionId, true)),

        interrupt: (sessionId) =>
          Effect.promise(async () => {
            const slot = active.get(sessionId);
            if (!slot) return;
            slot.stopping = true;
            slot.followUpWake = false;
            slot.controller.abort();
            try {
              await slot.promise;
            } catch {
              // Interruption is an expected control operation.
            }
          }),

        active: () => Effect.sync(() => [...active.keys()]),
      } satisfies Interface;
    }),
  );
}

// -----------------------------------------------------------------------------
// Sessions facade
// -----------------------------------------------------------------------------

namespace Sessions {
  export interface Interface {
    readonly create: (id?: string) => Effect.Effect<Session, Error>;
    readonly prompt: (input: {
      id?: string;
      sessionId: string;
      prompt: string;
      delivery?: PromptDelivery;
      resume?: boolean;
    }) => Effect.Effect<{ inputId: string; admittedSeq: number }, Error>;
    readonly run: (sessionId: string) => Effect.Effect<void, Error>;
    readonly interrupt: (sessionId: string) => Effect.Effect<void>;
    readonly active: () => Effect.Effect<readonly string[]>;
    readonly events: (sessionId: string) => Effect.Effect<StoredEvent[], Error>;
    readonly state: (sessionId: string) => Effect.Effect<unknown, Error>;
    readonly rebuild: (sessionId: string) => Effect.Effect<void, Error>;
  }

  export class Service extends Context.Service<Service, Interface>()(
    "mini-v2/Sessions",
  ) {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service;
      const coordinator = yield* SessionRunCoordinator.Service;

      return {
        create: store.create,

        prompt: ({
          id,
          sessionId,
          prompt,
          delivery = "queue",
          resume = true,
        }) =>
          Effect.gen(function* () {
            const receipt = yield* store.admit({
              id,
              sessionId,
              prompt,
              delivery,
            });
            if (resume) yield* coordinator.wake(sessionId);
            return receipt;
          }),

        run: coordinator.run,
        interrupt: coordinator.interrupt,
        active: coordinator.active,
        events: store.events,
        state: store.projectedState,
        rebuild: store.rebuildProjections,
      } satisfies Interface;
    }),
  );
}

// -----------------------------------------------------------------------------
// Layer composition
// -----------------------------------------------------------------------------

function appLayer(config: {
  dbPath: string;
  root: string;
  apiKey: string;
  model: string;
  baseURL: string;
}) {
  const database = Database.layer(config.dbPath);
  const store = SessionStore.layer.pipe(Layer.provideMerge(database));
  const llm = LLM.layer({
    apiKey: config.apiKey,
    model: config.model,
    baseURL: config.baseURL,
  });
  const tools = ToolRegistry.layer(config.root);

  const runnerDeps = Layer.mergeAll(store, llm, tools);
  const runner = SessionRunner.layer.pipe(Layer.provideMerge(runnerDeps));

  const coordinator = SessionRunCoordinator.layer.pipe(
    Layer.provideMerge(runner),
  );
  const sessions = Sessions.layer.pipe(Layer.provideMerge(coordinator));

  return sessions;
}

// -----------------------------------------------------------------------------
// Tiny CLI: product shell, not part of the core.
// -----------------------------------------------------------------------------

const prettyEvent = (event: StoredEvent) =>
  `${String(event.seq).padStart(4, " ")}  ${event.event.type}  ${JSON.stringify(event.event)}`;

const cli = Effect.gen(function* () {
  const sessions = yield* Sessions.Service;
  const rl = createInterface({ input, output });

  let current = (yield* sessions.create()).id;
  console.log(`mini-opencode-v2`);
  console.log(`session: ${current}`);
  console.log(
    `commands: /new  /use <id>  /events  /state  /rebuild  /interrupt  /quit`,
  );

  try {
    while (true) {
      const line = (yield* attemptPromise(() =>
        rl.question(`\n${current.slice(0, 8)}> `),
      )).trim();
      if (!line) continue;

      if (line === "/quit") break;

      if (line === "/new") {
        current = (yield* sessions.create()).id;
        console.log(`session: ${current}`);
        continue;
      }

      if (line.startsWith("/use ")) {
        const id = line.slice(5).trim();
        yield* sessions.create(id);
        current = id;
        console.log(`session: ${current}`);
        continue;
      }

      if (line === "/events") {
        const events = yield* sessions.events(current);
        for (const event of events) console.log(prettyEvent(event));
        continue;
      }

      if (line === "/state") {
        console.dir(yield* sessions.state(current), { depth: null });
        continue;
      }

      if (line === "/rebuild") {
        yield* sessions.rebuild(current);
        console.log("projections rebuilt from canonical event log");
        continue;
      }

      if (line === "/interrupt") {
        yield* sessions.interrupt(current);
        console.log("interrupted");
        continue;
      }

      // v2 semantics: first DURABLY admit, then schedule execution.
      const receipt = yield* sessions.prompt({
        sessionId: current,
        prompt: line,
      });
      console.log(`[admitted seq=${receipt.admittedSeq}]`);

      yield* sessions.run(current);
    }
  } finally {
    rl.close();
  }
});

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY");
  process.exitCode = 1;
} else {
  const layer = appLayer({
    dbPath: process.env.MINI_V2_DB ?? ".mini-opencode-v2-core.db",
    root: process.env.MINI_V2_ROOT ?? process.cwd(),
    apiKey,
    model: process.env.OPENAI_MODEL ?? "gpt-5",
    baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  });

  Effect.runPromise(cli.pipe(Effect.provide(layer))).catch((error) => {
    console.error(asError(error));
    process.exitCode = 1;
  });
}
