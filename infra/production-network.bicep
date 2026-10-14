targetScope = 'resourceGroup'
param location string = 'southeastasia'
param environmentName string = 'gpt-live-prod-env'
param storageName string = 'glragprod678b10'
param logsName string = 'realtime-psr-logs'

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'gpt-live-prod-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.124.0.0/16'] }
    subnets: [
      { name: 'apps', properties: { addressPrefix: '10.124.0.0/23', delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }] } }
      { name: 'endpoints', properties: { addressPrefix: '10.124.2.0/24', privateEndpointNetworkPolicies: 'Disabled' } }
    ]
  }
}
resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' existing = { name: storageName }
resource zone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.blob.core.windows.net'
  location: 'global'
}
resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zone
  name: 'gpt-live-prod'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: network.id } }
}
resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'gpt-live-prod-blob'
  location: location
  properties: {
    subnet: { id: '${network.id}/subnets/endpoints' }
    privateLinkServiceConnections: [{ name: 'blob', properties: { privateLinkServiceId: storage.id, groupIds: ['blob'] } }]
  }
}
resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'blob'
  properties: { privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: zone.id } }] }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = { name: logsName }
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  properties: {
    vnetConfiguration: { infrastructureSubnetId: '${network.id}/subnets/apps', internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey } }
  }
}
output environmentId string = environment.id
output defaultDomain string = environment.properties.defaultDomain
