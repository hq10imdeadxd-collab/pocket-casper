// Runs the model off the main thread so the chat stays smooth while it generates.
import { WebWorkerMLCEngineHandler } from "./vendor/web-llm.js";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
