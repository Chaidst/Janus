/**
 * MediaSearchService — fetches images via Google Custom Search and videos via YouTube Data API.
 * Uses plain fetch(), no additional npm packages required.
 */

export interface ImageResult {
    url: string;
    title: string;
    source: string;
}

export interface VideoResult {
    videoId: string;
    title: string;
    thumbnail: string;
}

export class MediaSearchService {
    private cseApiKey: string;
    private cseId: string;
    private youtubeApiKey: string;

    constructor() {
        this.cseApiKey = process.env.GOOGLE_CSE_API_KEY || '';
        this.cseId = process.env.GOOGLE_CSE_ID || '';
        this.youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
    }

    /**
     * Search Google Images via Custom Search JSON API.
     * Returns the top image result or null if nothing found.
     */
    async searchImage(query: string): Promise<ImageResult | null> {
        if (!this.cseApiKey || !this.cseId) {
            console.warn('MediaSearchService: Missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_ID');
            return null;
        }

        const safeQuery = `${query} for kids`;
        const url = `https://www.googleapis.com/customsearch/v1?` +
            `key=${encodeURIComponent(this.cseApiKey)}` +
            `&cx=${encodeURIComponent(this.cseId)}` +
            `&q=${encodeURIComponent(safeQuery)}` +
            `&searchType=image` +
            `&safe=active` +
            `&num=1`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            if (data.items && data.items.length > 0) {
                const item = data.items[0];
                return {
                    url: item.link,
                    title: item.title,
                    source: item.displayLink,
                };
            } else {
                console.warn('MediaSearchService: Custom Search API returned no items. Response:', data);
            }
            return null;
        } catch (error) {
            console.error('MediaSearchService: Image search failed:', error);
            return null;
        }
    }

    /**
     * Search YouTube videos via YouTube Data API v3.
     * Returns the top video result or null if nothing found.
     */
    async searchVideo(query: string): Promise<VideoResult | null> {
        if (!this.youtubeApiKey) {
            console.warn('MediaSearchService: Missing YOUTUBE_API_KEY');
            return null;
        }

        const safeQuery = `${query} for kids`;
        const url = `https://www.googleapis.com/youtube/v3/search?` +
            `key=${encodeURIComponent(this.youtubeApiKey)}` +
            `&q=${encodeURIComponent(safeQuery)}` +
            `&part=snippet` +
            `&type=video` +
            `&safeSearch=strict` +
            `&maxResults=1`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            if (data.items && data.items.length > 0) {
                const item = data.items[0];
                return {
                    videoId: item.id.videoId,
                    title: item.snippet.title,
                    thumbnail: item.snippet.thumbnails?.medium?.url || '',
                };
            } else {
                console.warn('MediaSearchService: YouTube API returned no items. Response:', data);
            }
            return null;
        } catch (error) {
            console.error('MediaSearchService: Video search failed:', error);
            return null;
        }
    }
}
