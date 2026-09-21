import { QueryClient } from "@tanstack/react-query";

/**
 * Defaults chosen to match how the app loaded data before TanStack Query:
 *
 * - No refetch on window focus. A desktop shell gains and loses focus all the
 *   time (the pet window, the terminal, a native file dialog), and nothing
 *   here refetched on focus before.
 * - No automatic retry. Failures surfaced immediately, and most of these
 *   calls shell out to git, gh, npm or Pi, where a silent retry only delays
 *   the same error.
 * - staleTime 0, the library default: opening a panel shows what is cached
 *   and refreshes it, which is what remounting did before minus the blank
 *   frame.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient = createQueryClient();
