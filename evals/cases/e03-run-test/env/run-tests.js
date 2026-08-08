import { summary } from "./util.js";
import "./double.js";

process.exit(summary() > 0 ? 1 : 0);
