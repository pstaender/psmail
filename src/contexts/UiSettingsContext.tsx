import { createContext, useContext } from "react";

/** The interface options of Settings → UI. Everything is opt-in: a missing provider or setting means the plain client. */
export interface UiSettings {
  showConversations: boolean;
  showCategories: boolean;
  showUnreadBadges: boolean;
  textViewOnly: boolean;
  showAbsoluteDates: boolean;
  showLetterAvatar: boolean;
}

export const PLAIN_UI: UiSettings = {
  showConversations: false,
  showCategories: false,
  showUnreadBadges: false,
  textViewOnly: false,
  showAbsoluteDates: false,
  showLetterAvatar: false,
};

export const UiSettingsContext = createContext<UiSettings>(PLAIN_UI);

export function useUiSettings(): UiSettings {
  return useContext(UiSettingsContext);
}
