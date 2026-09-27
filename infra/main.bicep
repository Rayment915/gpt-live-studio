targetScope = 'resourceGroup'

param location string = 'southeastasia'
param appName string = 'gpt-live-studio'
param environmentName string
param image string
param acrLoginServer string
param pullIdentityId string
@secure()
param foundryApiKey string

@secure()
param adminPasswordHash string

param foundryEndpoint string
param voiceDeployment string = 'gpt-live-1'
param responsesDeployment string = 'gpt-6-luna'

@description('Keep false until identity, access and cost review is complete.')
param externalIngress bool = false

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: environmentName
}

var appOrigin = externalIngress ? 'https://${appName}.${environment.properties.defaultDomain}' : 'https://${appName}.internal.${environment.properties.defaultDomain}'

resource studio 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: externalIngress
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        { server: acrLoginServer, identity: pullIdentityId }
      ]
      secrets: [
        { name: 'foundry-api-key', value: foundryApiKey }
        { name: 'admin-password-hash', value: adminPasswordHash }
      ]
    }
    template: {
      terminationGracePeriodSeconds: 30
      containers: [
        {
          name: 'studio'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '3000' }
            { name: 'AUTH_MODE', value: 'password' }
            { name: 'STUDIO_ADMIN_PASSWORD_HASH', secretRef: 'admin-password-hash' }
            { name: 'APP_ORIGIN', value: appOrigin }
            { name: 'AZURE_OPENAI_ENDPOINT', value: foundryEndpoint }
            { name: 'AZURE_OPENAI_API_KEY', secretRef: 'foundry-api-key' }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: voiceDeployment }
            { name: 'RESPONSES_DEPLOYMENT', value: responsesDeployment }
            { name: 'MAX_SESSIONS', value: '4' }
            { name: 'MAX_SESSION_SECONDS', value: '1800' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 15, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 5, periodSeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

resource authentication 'Microsoft.App/containerApps/authConfigs@2025-01-01' = {
  parent: studio
  name: 'current'
  properties: {
    platform: { enabled: false }
  }
}

output url string = appOrigin
