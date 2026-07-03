import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const eventHtml = readFileSync("event-widget.html", "utf8");

// Eventbrite config (set these in your env)
const EVENTBRITE_API_BASE = "https://www.eventbriteapi.com/v3";
const EVENTBRITE_TOKEN = "YOUR_TOKEN_HERE";
const EVENTBRITE_ORG_ID = "YOUR_ORG_ID_HERE";

if (!EVENTBRITE_TOKEN) {
  console.warn("Warning: EVENTBRITE_TOKEN is not set. Event tools will fail.");
}
if (!EVENTBRITE_ORG_ID) {
  console.warn("Warning: EVENTBRITE_ORG_ID is not set. getAllEvents will fail.");
}

// Tool input schemas
const getAllEventsInputSchema = {
  status: z
    .enum(["all", "live", "draft", "started", "ended", "completed", "canceled"])
    .optional()
    .default("live"),
};

const getEventInputSchema = {
  id: z.string().min(1),
};

const buyTicketInputSchema = {
  id: z.string().min(1),
  quantity: z.number().int().min(1).optional().default(1),
};

// Helper: call Eventbrite API
async function callEventbrite(path, searchParams) {
  if (!EVENTBRITE_TOKEN) {
    throw new Error("EVENTBRITE_TOKEN is not configured");
  }

  // Ensure we get e.g. https://www.eventbriteapi.com/v3/organizations/.../events/
  const url = new URL(EVENTBRITE_API_BASE + path);

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value != null) {
        url.searchParams.set(key, value);
      }
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${EVENTBRITE_TOKEN}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Eventbrite request failed (${response.status} ${response.statusText}): ${body}`
    );
  }

  return response.json();
}

// Helpers to shape responses for the widget
const replyWithEvents = (message, events) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { events },
});

const replyWithEvent = (message, event) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { event },
});

function createEventServer() {
  const server = new McpServer({ name: "event-planner-app", version: "0.1.0" });

  // Widget resource
  server.registerResource(
    "event-widget",
    "ui://widget/events.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/events.html",
          mimeType: "text/html+skybridge",
          text: eventHtml,
          _meta: { "openai/widgetPrefersBorder": true },
        },
      ],
    })
  );

  // getAllEvents
  server.registerTool(
    "getAllEvents",
    {
      title: "Get all events",
      description: "Fetches events from Eventbrite for the configured organization.",
      inputSchema: getAllEventsInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/events.html",
        "openai/toolInvocation/invoking": "Loading events from Eventbrite",
        "openai/toolInvocation/invoked": "Loaded events from Eventbrite",
      },
    },
    async (args) => {
      if (!EVENTBRITE_ORG_ID) {
        return replyWithEvents(
          "EVENTBRITE_ORG_ID is not configured on the server.",
          []
        );
      }

      const status = args?.status ?? "live";

      try {
        const data = await callEventbrite(
          `/organizations/${EVENTBRITE_ORG_ID}/events/`,
          { status }
        );

        const eventsArray = Array.isArray(data.events) ? data.events : [];
        if (!eventsArray.length) {
          return replyWithEvents("No events found for this organization.", []);
        }

        return replyWithEvents(
          `Found ${eventsArray.length} event(s) on Eventbrite.`,
          eventsArray
        );
      } catch (error) {
        console.error("getAllEvents error:", error);
        return replyWithEvents(
          "There was an error fetching events from Eventbrite.",
          []
        );
      }
    }
  );

  // getEvent
  server.registerTool(
    "getEvent",
    {
      title: "Get event by id",
      description: "Fetches a single Eventbrite event by id.",
      inputSchema: getEventInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/events.html",
        "openai/toolInvocation/invoking": "Loading event details from Eventbrite",
        "openai/toolInvocation/invoked": "Loaded event details from Eventbrite",
      },
    },
    async (args) => {
      const id = args?.id?.trim?.();
      if (!id) {
        return replyWithEvent("Missing event id.", null);
      }

      try {
        const event = await callEventbrite(`/events/${id}/`);
        return replyWithEvent(`Loaded event "${event.name?.text ?? id}".`, event);
      } catch (error) {
        console.error("getEvent error:", error);
        return replyWithEvent(
          `There was an error fetching event ${id} from Eventbrite.`,
          null
        );
      }
    }
  );

  // buyTicket
  server.registerTool(
    "buyTicket",
    {
      title: "Buy ticket for an event",
      description:
        "Provides a ticket purchase link for an Eventbrite event. This does not complete the purchase but returns the correct URL.",
      inputSchema: buyTicketInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/events.html",
        "openai/toolInvocation/invoking": "Preparing ticket purchase link",
        "openai/toolInvocation/invoked": "Provided ticket purchase link",
      },
    },
    async (args) => {
      const id = args?.id?.trim?.();
      const quantity = args?.quantity ?? 1;

      if (!id) {
        return replyWithEvent("Missing event id.", null);
      }

      try {
        const event = await callEventbrite(`/events/${id}/`);

        const eventUrl = event.url;
        const name = event.name?.text ?? id;

        const messageParts = [
          `To buy ${quantity} ticket${quantity > 1 ? "s" : ""} for "${name}", open this link in your browser.`,
        ];
        if (eventUrl) {
          messageParts.push(eventUrl);
        } else {
          messageParts.push("No Eventbrite URL was found for this event.");
        }

        return replyWithEvent(messageParts.join(" "), event);
      } catch (error) {
        console.error("buyTicket error:", error);
        return replyWithEvent(
          `There was an error preparing the ticket purchase for event ${id}.`,
          null
        );
      }
    }
  );

  return server;
}

// HTTP server wiring – identical style to the docs
const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Event Planner MCP server");
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createEventServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(
    `Event Planner MCP server listening on http://localhost:${port}${MCP_PATH}`
  );
});
