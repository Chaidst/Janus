/**
 * MediaSearchService — fetches images via Vertex AI Search and videos via YouTube Data API.
 */
import { SearchServiceClient } from '@google-cloud/discoveryengine';

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
    private searchClient: SearchServiceClient;
    private vertexProjectId: string;
    private vertexLocation: string;
    private vertexDataStoreId: string;
    // private cseApiKey: string;
    // private cseId: string;
    private youtubeApiKey: string;

    constructor() {
        this.searchClient = new SearchServiceClient();
        this.vertexProjectId = process.env.VERTEX_AI_SEARCH_PROJECT_ID || '';
        this.vertexLocation = process.env.VERTEX_AI_SEARCH_LOCATION || '';
        this.vertexDataStoreId = process.env.VERTEX_AI_SEARCH_DATA_STORE_ID || '';
        // this.cseApiKey = process.env.GOOGLE_CSE_API_KEY || '';
        // this.cseId = process.env.GOOGLE_CSE_ID || '';
        this.youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
    }

    /**
     * Search Google Images via Vertex AI Search.
     * Returns the top image result or null if nothing found.
     */
    async searchImage(query: string): Promise<ImageResult | null> {
        // --- CUSTOM SEARCH API IMPLEMENTATION (COMMENTED OUT FOR FUTURE USE) ---
        /*
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
            `&num=10`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            if (data.items && data.items.length > 0) {
                // Ensure we return a valid image URL instead of a webpage URL
                for (const item of data.items) {
                    const imgUrl = item.link || item.image?.thumbnailLink || item.image?.contextLink;
                    if (imgUrl && (imgUrl.match(/\.(jpeg|jpg|gif|png|webp)/i) || imgUrl.includes('googleusercontent.com') || imgUrl.includes('encrypted-tbn0.gstatic.com'))) {
                        return {
                            url: imgUrl,
                            title: item.title,
                            source: item.image?.contextLink || item.displayLink || 'Google Image Search',
                        };
                    }
                }
                
                // Fallback to the first item if strict matching fails
                const firstItem = data.items[0];
                return {
                    url: firstItem.link,
                    title: firstItem.title,
                    source: firstItem.image?.contextLink || firstItem.displayLink,
                };
            } else {
                console.warn('MediaSearchService: Custom Search API returned no items. Response:', JSON.stringify(data, null, 2));
            }
            return null;
        } catch (error) {
            console.error('MediaSearchService: Image search failed:', error);
            return null;
        }
        */
        // ----------------------------------------------------------------------


        if (!this.vertexProjectId || !this.vertexLocation || !this.vertexDataStoreId) {
            console.warn('MediaSearchService: Missing Vertex AI Search configuration');
            return null;
        }

        const safeQuery = `${query} for kids`;
        
        try {
            const servingConfig = this.searchClient.projectLocationCollectionDataStoreServingConfigPath(
                this.vertexProjectId,
                this.vertexLocation,
                'default_collection',
                this.vertexDataStoreId,
                'default_search'
            );

            const request = {
                servingConfig,
                query: safeQuery,
                pageSize: 5,
            };

            const [results] = await this.searchClient.search(request, { autoPaginate: false });

            if (results && results.length > 0) {
                for (const res of results) {
                    const doc = res.document;
                    
                    const pb = doc?.derivedStructData?.fields;
                    const pageMap = pb?.pagemap?.structValue?.fields;

                    let url = '';
                    const cseImage = pageMap?.cse_image?.listValue?.values?.[0]?.structValue?.fields?.src?.stringValue;
                    const ogImage = pageMap?.metatags?.listValue?.values?.[0]?.structValue?.fields?.['og:image']?.stringValue;
                    
                    url = cseImage || ogImage || pb?.link?.stringValue || '';

                    if (url && typeof url === 'string') {
                        // Basic sanity check for common image extensions
                        if (url.match(/\.(jpeg|jpg|gif|png|webp|svg)/i) || url.includes('googleusercontent.com') || url.includes('encrypted-tbn0.gstatic.com')) {
                            const titleStr = pb?.title?.stringValue || pb?.htmlTitle?.stringValue || query;
                            return {
                                url: url as string,
                                title: typeof titleStr === 'string' ? titleStr : query,
                                source: 'Vertex AI Search',
                            };
                        }
                    }
                }
            }
            
            console.warn('MediaSearchService: Vertex AI Search returned no usable image items.');
            return null;
        } catch (error) {
            console.error('MediaSearchService: Vertex Image search failed:', error);
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
                console.warn('MediaSearchService: YouTube API returned no items. Response:', JSON.stringify(data, null, 2));
            }
            return null;
        } catch (error) {
            console.error('MediaSearchService: Video search failed:', error);
            return null;
        }
    }
}
