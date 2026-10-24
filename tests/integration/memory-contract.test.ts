import { createMemoryRepository } from "@aff/db";
import { repositoryContract } from "./contract.js";

repositoryContract("memory", () => createMemoryRepository());
