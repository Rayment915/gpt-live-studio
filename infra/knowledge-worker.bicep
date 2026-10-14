targetScope = 'resourceGroup'
param location string = 'southeastasia'
param jobName string = 'gpt-live-knowledge-worker'
param environmentId string
param image string
param identityId string
param identityClientId string
param acrLoginServer string
param storageUrl string
param searchEndpoint string
@secure()
param searchKey string
param ocrEndpoint string
param embeddingEndpoint string
param embeddingDeployment string

resource worker 'Microsoft.App/jobs@2025-01-01' = {
  name: jobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      scheduleTriggerConfig: { cronExpression: '* * * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acrLoginServer, identity: identityId }]
      secrets: [{ name: 'search-key', value: searchKey }]
    }
    template: {
      containers: [{
        name: 'worker'
        image: image
        resources: { cpu: 1, memory: '2Gi' }
        env: [
          { name: 'AZURE_CLIENT_ID', value: identityClientId }
          { name: 'KNOWLEDGE_STORAGE_URL', value: storageUrl }
          { name: 'KNOWLEDGE_CONTAINER', value: 'gpt-live-prod' }
          { name: 'KNOWLEDGE_INDEX_PREFIX', value: 'gpt-live-prod' }
          { name: 'KNOWLEDGE_SEARCH_ENDPOINT', value: searchEndpoint }
          { name: 'KNOWLEDGE_SEARCH_KEY', secretRef: 'search-key' }
          { name: 'KNOWLEDGE_OCR_ENDPOINT', value: ocrEndpoint }
          { name: 'KNOWLEDGE_EMBEDDING_ENDPOINT', value: embeddingEndpoint }
          { name: 'KNOWLEDGE_EMBEDDING_DEPLOYMENT', value: embeddingDeployment }
          { name: 'KNOWLEDGE_WORKER_IDLE_EXIT_SECONDS', value: '15' }
          { name: 'KNOWLEDGE_WORKER_MAX_SECONDS', value: '1500' }
        ]
      }]
    }
  }
}
output workerId string = worker.id
