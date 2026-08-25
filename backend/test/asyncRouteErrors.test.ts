import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import * as asyncRouteErrors from "../src/middleware/asyncRouteErrors";
import { createAsyncRouter } from "../src/middleware/asyncRouteErrors";
import { projectsRouter } from "../src/routes/projects";

type RouterLayer = {
  route?: {
    path?: unknown;
    stack?: Array<{
      handle: (req: Request, res: Response, next: NextFunction) => unknown;
    }>;
  };
};

const apiErrorHandler = (
  asyncRouteErrors as typeof asyncRouteErrors & {
    apiErrorHandler?: ErrorRequestHandler;
  }
).apiErrorHandler;

async function withApp(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("route routers forward rejected async callbacks to Express error handling", async () => {
  const path = "/__async-route-rejection-regression__";
  const rejection = new Error("storage dependency rejected");
  projectsRouter.post(path, async () => {
    throw rejection;
  });

  const layers = (projectsRouter as unknown as { stack: RouterLayer[] }).stack;
  const layer = layers.find((candidate) => candidate.route?.path === path);
  const handler = layer?.route?.stack?.at(-1)?.handle;
  assert.ok(handler, "expected the regression route to be registered");

  let forwarded: unknown;
  const returned = handler(
    {} as Request,
    {} as Response,
    ((error?: unknown) => {
      forwarded = error;
    }) as NextFunction,
  );
  if (
    returned &&
    typeof (returned as PromiseLike<unknown>).then === "function"
  ) {
    await Promise.resolve(returned).catch(() => undefined);
  }

  assert.equal(forwarded, rejection);
});

test("the final API error handler hides internal async failures", async () => {
  const app = express();
  const router = createAsyncRouter();
  const sensitiveMessage = "database password appeared in an internal failure";
  router.get("/failure", async () => {
    throw new Error(sensitiveMessage);
  });
  app.use(router);
  if (apiErrorHandler) app.use(apiErrorHandler);

  await withApp(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/failure`);
    const body = await response.text();

    assert.equal(response.status, 500);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/json/,
    );
    assert.deepEqual(JSON.parse(body), { detail: "Internal server error" });
    assert.doesNotMatch(body, new RegExp(sensitiveMessage, "i"));
  });
});

test("the final API error handler delegates after SSE headers are sent", () => {
  const error = new Error("stream failed after opening");
  let forwarded: unknown;

  apiErrorHandler?.(
    error,
    {} as Request,
    { headersSent: true } as Response,
    ((nextError?: unknown) => {
      forwarded = nextError;
    }) as NextFunction,
  );

  assert.equal(forwarded, error);
});

test("async routing preserves direct 4xx and SSE responses", async () => {
  const app = express();
  const router = createAsyncRouter();
  router.get("/validation", async (_req, res) => {
    res.status(422).json({ detail: "A project name is required" });
  });
  router.get("/events", async (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"type":"done"}\n\n');
    res.end();
  });
  app.use(router);
  if (apiErrorHandler) app.use(apiErrorHandler);

  await withApp(app, async (baseUrl) => {
    const validation = await fetch(`${baseUrl}/validation`);
    assert.equal(validation.status, 422);
    assert.deepEqual(await validation.json(), {
      detail: "A project name is required",
    });

    const events = await fetch(`${baseUrl}/events`);
    assert.equal(events.status, 200);
    assert.match(
      events.headers.get("content-type") ?? "",
      /^text\/event-stream/,
    );
    assert.equal(await events.text(), 'data: {"type":"done"}\n\n');
  });
});
