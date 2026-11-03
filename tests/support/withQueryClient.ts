import { createElement, type ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../../src/lib/queryClient";

/**
 * Wrap an element the way main.tsx does, with a fresh client per render so
 * one test's cache never answers another's queries.
 */
export function withQueryClient(element: ReactElement): ReactElement {
  return createElement(QueryClientProvider, { client: createQueryClient() }, element);
}
