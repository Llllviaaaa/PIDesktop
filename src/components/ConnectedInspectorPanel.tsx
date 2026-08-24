import type { ComponentProps } from "react";
import { usePiStore } from "../store";
import { InspectorPanel } from "./InspectorPanel";

export function ConnectedInspectorPanel(props: Omit<ComponentProps<typeof InspectorPanel>, "messages">) {
  const messages = usePiStore((state) => state.messages);
  return <InspectorPanel {...props} messages={messages} />;
}
