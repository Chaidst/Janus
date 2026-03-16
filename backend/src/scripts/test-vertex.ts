import { SearchServiceClient } from '@google-cloud/discoveryengine';

async function testSearch() {
    const client = new SearchServiceClient();
    const projectId = process.env.VERTEX_AI_SEARCH_PROJECT_ID;
    const location = process.env.VERTEX_AI_SEARCH_LOCATION;
    const dataStoreId = process.env.VERTEX_AI_SEARCH_DATA_STORE_ID;

    if (!projectId || !location || !dataStoreId) {
        throw new Error('Missing environment variables');
    }

    const servingConfig = client.projectLocationCollectionDataStoreServingConfigPath(
        projectId,
        location,
        'default_collection',
        dataStoreId,
        'default_search'
    );

    const request = {
        servingConfig,
        query: 'Ronaldo photo',
        pageSize: 1,
    };

    console.log("Searching...");
    const [results] = await client.search(request, { autoPaginate: false });
    
    if (results && results.length > 0) {
        console.log(JSON.stringify(results[0], null, 2));
    } else {
        console.log("No results returned by the API.");
    }
}

testSearch().catch(console.error);
