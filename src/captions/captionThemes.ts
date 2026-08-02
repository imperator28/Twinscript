import themeData from '../../shared/caption-themes.json';
import type { Audience, CaptionSettings } from './types';

export type CaptionThemeId = CaptionSettings['captionTheme'];

export interface CaptionThemeSurface {
  background: string;
  primary: string;
  secondary: string;
  accent: string;
  border: string;
  nativeBackground: string;
}

export interface CaptionTheme {
  id: CaptionThemeId;
  label: string;
  palette: string[];
  surfaces: Record<Audience, CaptionThemeSurface>;
}

export const captionThemes = themeData as CaptionTheme[];
export const defaultCaptionTheme =
  captionThemes.find((theme) => theme.id === 'blueprint') || captionThemes[0];

export function captionThemeById(id: string | undefined) {
  return captionThemes.find((theme) => theme.id === id) || defaultCaptionTheme;
}
