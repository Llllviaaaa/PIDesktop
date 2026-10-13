import { type MouseEvent } from "react";
import { BUILTIN_APPEARANCE_CATALOG, resolveAppearancePet, type AppearancePetDefinition, type PetAnimationState } from "../lib/appearanceCatalog";
import { usePiStore } from "../store";
import { PetAvatar, usePetInteractionController } from "./PetCompanion";

interface ComposerPixelPetProps {
  pet?: AppearancePetDefinition;
  isStreaming?: boolean;
  isThinking?: boolean;
  isCompacting?: boolean;
  hasNotification?: boolean;
  hasError?: boolean;
}

export function ClaudeComposerCrab({
  pet,
  isStreaming = false,
  isThinking = false,
  isCompacting = false,
  hasNotification = false,
  hasError = false,
}: ComposerPixelPetProps) {
  const petCharacter = usePiStore((state) => state.settings?.petCharacter ?? "cat");
  const resolvedPet = pet ?? resolveAppearancePet(BUILTIN_APPEARANCE_CATALOG, petCharacter);

  const activity: PetAnimationState = hasError
    ? "failed"
    : hasNotification
      ? "waiting"
      : isCompacting
        ? "review"
        : isThinking
          ? "review"
          : isStreaming
            ? "running"
            : "idle";

  const controller = usePetInteractionController(resolvedPet, activity);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const nextState: PetAnimationState = controller.animationState === "waving" ? "jumping" : "waving";
    controller.playInteraction(nextState, nextState === "jumping" ? 950 : 1_250);
  };

  return (
    <div className="composer-pixel-pet" data-state={controller.animationState}>
      {controller.message && (
        <span className="composer-pixel-pet-bubble" role="status" aria-live="polite">
          {controller.message}
        </span>
      )}
      <button
        type="button"
        className="composer-pixel-pet-btn"
        onClick={handleClick}
        title={`${resolvedPet.label} · 点击互动`}
        aria-label={`${resolvedPet.label}，点击互动`}
      >
        <PetAvatar
          pet={resolvedPet}
          busy={isStreaming}
          state={controller.animationState}
        />
      </button>
    </div>
  );
}
