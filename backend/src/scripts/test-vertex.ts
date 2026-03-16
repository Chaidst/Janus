import { MediaSearchService } from './media-search-service.js';

async function testSearch() {
    const service = new MediaSearchService();
    const query = process.env.TEST_QUERY || 'Ronaldo photo';

    console.log(`Searching for: ${query}...`);
    const result = await service.searchImage(query);
    
    if (result) {
        console.log("Found image result:");
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log("No usable image results found.");
    }
}

testSearch().catch(console.error);
