import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { SAPClient } from './sap-client.js';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';
import { ODataService, EntityType, ServiceMetadata } from '../types/sap-types.js';

import { JSDOM } from 'jsdom';
import { tr } from 'zod/v4/locales';

export class SAPDiscoveryService {
    private catalogEndpoints = [
        '/sap/opu/odata4/iwfnd/config/default/iwfnd/catalog/0002/ServiceGroups?$expand=DefaultSystem($expand=Services)',
        '/sap/opu/odata/sap/$metadata'
    ];

    constructor(
        private sapClient: SAPClient,
        private logger: Logger,
        private config: Config
    ) { }

    async discoverAllServices(): Promise<ODataService[]> {
        const services: ODataService[] = [];

        try {
            // Log current filtering configuration
            const filterConfig = this.config.getServiceFilterConfig();
            this.logger.info('OData service discovery configuration:', filterConfig);

            // // Try OData V4 catalog first
            // const v4Services = await this.discoverV4Services();
            // services.push(...v4Services);

            // Fallback to V2 service discovery
            // if (services.length === 0) {
                const v2Services = await this.discoverV2Services();
                services.push(...v2Services);

                
            // Apply service filtering based on configuration
            const filteredServices = this.filterServices(services);
            this.logger.info(`Discovered ${services.length} total services, ${filteredServices.length} match the filter criteria`);

            // Apply maximum service limit
            const maxServices = this.config.getMaxServices();
            const limitedServices = filteredServices.slice(0, maxServices);

            if (filteredServices.length > maxServices) {
                this.logger.warn(`Service discovery limited to ${maxServices} services (configured maximum). ${filteredServices.length - maxServices} services were excluded.`);
            }

            // Enrich services with metadata (skip failed services instead of failing completely)
            const workingServices: ODataService[] = [];
            for (const service of limitedServices) {
                try {
                    this.logger.debug(`Discovering metadata for service: ${service.id} at ${service.metadataUrl}`);
                    service.metadata = await this.getServiceMetadata(service);
                    workingServices.push(service);
                    this.logger.debug(`✅ Successfully loaded metadata for service: ${service.id}`);
                } catch (error) {
                    this.logger.warn(`⚠️  Skipping service ${service.id} due to metadata error:`, error instanceof Error ? error.message : error);
                    // Continue with next service instead of failing
                }
            }

            this.logger.info(`Successfully initialized ${workingServices.length} OData services (${limitedServices.length - workingServices.length} services skipped due to metadata errors)`);
            return workingServices;

        } catch (error) {
            this.logger.error('Service discovery failed:', error);
            throw error;
        }
    }

    /**
     * Filter services based on configuration patterns
     */
    private filterServices(services: ODataService[]): ODataService[] {
        const allowAll = this.config.get('odata.allowAllServices', false);

        if (allowAll) {
            this.logger.info('All services allowed - no filtering applied');
            return services;
        }

        const filteredServices = services.filter(service => {
            const isAllowed = this.config.isServiceAllowed(service.id);
            if (isAllowed) {
                this.logger.debug(`Service included: ${service.id}`);
            }
            return isAllowed;
        });

        return filteredServices;
    }

    private async discoverV4Services(): Promise<ODataService[]> {
        try {
            const destination = await this.sapClient.getDestination();

            const response = await executeHttpRequest(destination, {
                method: 'GET',
                url: this.catalogEndpoints[0],
                headers: {
                    'Accept': 'application/json'
                }
            });

            return this.parseV4CatalogResponse(response.data);

        } catch (error) {
            this.logger.warn('V4 service discovery failed:', error);
            return [];
        }
    }

    private async discoverV2Services(): Promise<ODataService[]> {
        try {
            const destination = await this.sapClient.getDestination();

            const response = await executeHttpRequest(destination, {
                method: 'GET',
                url: '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection',
                headers: {
                    'Accept': 'application/json'
                }
            });

            return this.parseV2CatalogResponse(response.data);

        } catch (error) {
            this.logger.error('V2 service discovery failed:', error);
            return [];
        }
    }

    private parseV4CatalogResponse(catalogData: unknown): ODataService[] {
        interface Service {
            ServiceId: string;
            ServiceVersion?: string;
            Title?: string;
            Description?: string;
        }
        interface ServiceGroup {
            DefaultSystem?: { Services?: Service[] };
        }
        const services: ODataService[] = [];
        const value = (catalogData as { value?: ServiceGroup[] }).value;
        if (value) {
            value.forEach((serviceGroup) => {
                if (serviceGroup.DefaultSystem?.Services) {
                    serviceGroup.DefaultSystem.Services.forEach((service) => {
                        services.push({
                            id: service.ServiceId,
                            version: service.ServiceVersion || '0001',
                            title: service.Title || service.ServiceId,
                            description: service.Description || `OData service ${service.ServiceId}`,
                            odataVersion: 'v4',
                            url: `/sap/opu/odata4/sap/${service.ServiceId.toLowerCase()}/srvd/sap/${service.ServiceId.toLowerCase()}/${service.ServiceVersion || '0001'}/`,
                            metadataUrl: `/sap/opu/odata4/sap/${service.ServiceId.toLowerCase()}/srvd/sap/${service.ServiceId.toLowerCase()}/${service.ServiceVersion || '0001'}/$metadata`,
                            entitySets: [],
                            metadata: null
                        });
                    });
                }
            });
        }
        return services;
    }

    private parseV2CatalogResponse(catalogData: unknown): ODataService[] {
        interface V2Service {
            ID: string;
            TechnicalServiceVersion?: string;
            Title?: string;
            Description?: string;
            ServiceUrl: string;
            TechnicalServiceName: string;
        }
        const services: ODataService[] = [];
        const results = (catalogData as { d?: { results?: V2Service[] } }).d?.results;
        if (results) {
            results.forEach((service) => {
                const baseURL = `/sap/opu/odata/${service.ServiceUrl.split("/sap/opu/odata/")[1]}${service.TechnicalServiceName.includes("TASKPROCESSING") && Number(service.TechnicalServiceVersion)>1?`;mo`:``}/`;
                services.push({
                    id: service.ID,
                    version: service.TechnicalServiceVersion || '0001',
                    title: service.Title || service.ID,
                    description: service.Description || `OData service ${service.ID}`,
                    odataVersion: 'v2',
                    url: baseURL,
                    metadataUrl: `${baseURL}$metadata`,
                    entitySets: [],
                    metadata: null
                });
            });
        }
        return services;
    }

    private async getServiceMetadata(service: ODataService): Promise<ServiceMetadata> {
        try {
            const destination = await this.sapClient.getDestination();

            const response = await executeHttpRequest(destination, {
                method: 'GET',
                url: service.metadataUrl,
                headers: {
                    'Accept': 'application/xml'
                }
            });
            return this.parseMetadata(response.data, service.odataVersion);

        } catch (error) {
            this.logger.error(`Failed to get metadata for service ${service.id}:`, error);
            throw error;
        }
    }

    private parseMetadata(metadataXml: string, odataVersion: string): ServiceMetadata {
        const dom = new JSDOM(metadataXml);
        const xmlDoc = dom.window.document;

        const entitySets = this.extractEntitySets(xmlDoc);
        const entityTypes = this.extractEntityTypes(xmlDoc, entitySets);

        return {
            entityTypes,
            entitySets,
            version: odataVersion,
            namespace: this.extractNamespace(xmlDoc)
        };
    }

    private extractEntityTypes(xmlDoc: Document, entitySets: Array<{ [key: string]: string | boolean | null }>): EntityType[] {
        const entityTypes: EntityType[] = [];
        const nodes = xmlDoc.querySelectorAll("EntityType");

    nodes.forEach((node: Element) => {
            const entitySet = entitySets.find(entitySet=>(entitySet.entitytype as string)?.split(".")[1] === node.getAttribute("Name"));
            const entityType: EntityType =      {
                name: node.getAttribute("Name") || '',
                namespace: node.parentElement?.getAttribute("Namespace") || '',
                entitySet:entitySet?.name as string,
                creatable: !!entitySet?.creatable,
                updatable: !!entitySet?.updatable,
                deletable: !!entitySet?.deletable,
                addressable: !!entitySet?.addressable,
                properties: [],
                navigationProperties: [],
                keys: []
            };

            // Extract properties
            const propNodes = node.querySelectorAll("Property");
            propNodes.forEach((propNode: Element) => {
                entityType.properties.push({
                    name: propNode.getAttribute("Name") || '',
                    type: propNode.getAttribute("Type") || '',
                    nullable: propNode.getAttribute("Nullable") !== "false",
                    maxLength: propNode.getAttribute("MaxLength") ?? undefined
                });
            });

            // Extract keys
            const keyNodes = node.querySelectorAll("Key PropertyRef");
            keyNodes.forEach((keyNode: Element) => {
                entityType.keys.push(keyNode.getAttribute("Name") || '');
            });

            entityTypes.push(entityType);
        });

        return entityTypes;
    }

    private extractEntitySets(xmlDoc: Document): Array<{ [key: string]: string | boolean | null }> {
        const entitySets: Array< { [key: string]: string | boolean | null }> = [];
        const nodes = xmlDoc.querySelectorAll("EntitySet");

    nodes.forEach((node: Element) => {
            const entityset: { [key: string]: string | boolean | null } = {};
            ['name','entitytype', 'sap:creatable', 'sap:updatable', 'sap:deletable', 'sap:pageable', 'sap:addressable', 'sap:content-version'].forEach(attr => {
                const [namespace, name ] = attr.split(":");
                entityset[name||namespace] = node.getAttribute(attr);
            });
            ['sap:creatable', 'sap:updatable', 'sap:deletable', 'sap:pageable', 'sap:addressable'].forEach(attr => {
                const [namespace, name ] = attr.split(":");
                entityset[name||namespace] = node.getAttribute(attr) === "false" ? false : true;
            });
            if (entityset.name) {
                entitySets.push(entityset);
            }
        });

        return entitySets;
    }

    private extractNamespace(xmlDoc: Document): string {
        const schemaNode = xmlDoc.querySelector("Schema");
        return schemaNode?.getAttribute("Namespace") || '';
    }
}
