// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Third-party games: the providers, their catalogue, and a launch. */
import apiClient from '../apiClient';

const DISPLAY = { staleOnError: true } as const;

export const providers = (): Promise<any> =>
  apiClient.get('/api/game/providers', DISPLAY);

export const catalogue = (category?: string): Promise<any> =>
  category
    ? apiClient.get(`/api/game/games?category=${encodeURIComponent(category)}`, DISPLAY)
    : apiClient.get('/api/game/games', DISPLAY);

export const categories = (): Promise<any> =>
  apiClient.get('/api/game/categories', DISPLAY);

/** A session URL for one game; the provider's iframe loads it. */
export const launch = (game: { providerKey: string; gameId: string; gameName: string }): Promise<any> =>
  apiClient.post('/api/game/launch', game);
