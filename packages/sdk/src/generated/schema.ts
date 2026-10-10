export type paths = {
    readonly "/healthz": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Process liveness */
        readonly get: operations["getHealth"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/openapi.json": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Download the public OpenAPI contract */
        readonly get: operations["getOpenApiDocument"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/readyz": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Dependency and drain readiness */
        readonly get: operations["getReadiness"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/agents": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List latest agent definitions */
        readonly get: operations["listAgents"];
        readonly put?: never;
        /** Create an immutable agent definition at version 1 */
        readonly post: operations["createAgent"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/agents/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Get an agent definition version */
        readonly get: operations["getAgent"];
        /** Create the next immutable version of an agent */
        readonly put: operations["updateAgent"];
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/capabilities": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Discover implemented protocol capabilities */
        readonly get: operations["getCapabilities"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/data-erasure-requests": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Gate a user's data for asynchronous erasure
         * @description Admin-only and capability-gated. Atomically blocks new user-owned writes and creates an auditable request; it does not claim physical purge is complete.
         */
        readonly post: operations["requestUserErasure"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/data-erasure-requests/{requestId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Read an owned user erasure request */
        readonly get: operations["getUserErasureRequest"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/data-export-requests": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Request an asynchronous user data export
         * @description Admin-only, user-scoped and capability-gated. Idempotently queues a point-in-time NDJSON export artifact; no partial artifact is downloadable.
         */
        readonly post: operations["requestUserDataExport"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/data-export-requests/{requestId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Read an owned user data export request */
        readonly get: operations["getUserDataExportRequest"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/data-export-requests/{requestId}/download": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Download a ready user data export artifact
         * @description Streams the complete owner-scoped artifact only while the request is ready and unexpired. Missing, expired, revoked and ownership-mismatched artifacts return the same private 404 response.
         */
        readonly get: operations["downloadUserDataExport"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/legal-holds": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List active holds and their subject control */
        readonly get: operations["listActiveLegalHolds"];
        readonly put?: never;
        /**
         * Set a tenant- or user-scoped legal hold
         * @description Admin-only generation-CAS operation. A hold pauses destructive work but never restores ordinary API visibility.
         */
        readonly post: operations["setLegalHold"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/legal-holds/{holdId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Read one tenant-owned legal hold */
        readonly get: operations["getLegalHold"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/legal-holds/{holdId}/release": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Release one legal hold
         * @description Admin-only generation-CAS release. Other active holds on the same subject remain effective.
         */
        readonly post: operations["releaseLegalHold"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/models": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List models visible to the tenant */
        readonly get: operations["listModels"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/providers": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List visible provider configurations with secrets redacted */
        readonly get: operations["listProviders"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/providers/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        /** Create or replace a tenant provider configuration */
        readonly put: operations["upsertProvider"];
        readonly post?: never;
        /** Delete a tenant provider configuration */
        readonly delete: operations["deleteProvider"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/retention-policies/{policyVersion}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Read an immutable tenant retention policy version */
        readonly get: operations["getRetentionPolicy"];
        /**
         * Register an immutable tenant retention policy version
         * @description Admin-only and rollout-gated. Registering a version does not activate it and cannot authorize purge.
         */
        readonly put: operations["putRetentionPolicy"];
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/retention-policies/{policyVersion}/activate": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Activate a canonical tenant retention policy
         * @description Admin-only generation-CAS activation. It affects only requests created after the activation linearization point; existing backlog is never adopted implicitly.
         */
        readonly post: operations["activateRetentionPolicy"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/retention-policies/active": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Read the active canonical tenant retention policy */
        readonly get: operations["getActiveRetentionPolicy"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * List sessions visible to the caller
         * @description A user identity confines the result to that user. Listing tenant-wide requires an admin-scoped key.
         */
        readonly get: operations["listSessions"];
        readonly put?: never;
        /** Create a session pinned to an agent version */
        readonly post: operations["createSession"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Get a session */
        readonly get: operations["getSession"];
        readonly put?: never;
        readonly post?: never;
        /**
         * Tombstone a session
         * @description Idempotently tombstones a visible or archived idle session through the lease/fence path. A retry by the same owner returns 204 without another event or generation; an active session returns session_busy and a parent with non-deleted children returns session_has_children. After success all normal resource APIs return 404. Physical purge remains disabled until retention policy is configured.
         */
        readonly delete: operations["deleteSession"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/approvals": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List approvals in a session */
        readonly get: operations["listApprovals"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/approvals/{approvalId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /** Resolve a pending approval */
        readonly post: operations["resolveApproval"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/archive": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Archive a session
         * @description Idempotently archives an idle session through the lease/fence path. Archived sessions remain readable but reject new mutable runtime operations.
         */
        readonly post: operations["archiveSession"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/blobs": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Stage an input image for a session
         * @description Uploads raw bytes and returns an opaque, owner-scoped blob id. A staging blob is not readable until a turn or steer request atomically attaches it. Cross-tenant, cross-user and cross-session lookups return 404.
         */
        readonly post: operations["uploadSessionBlob"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/blobs/{blobId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Read an attached session blob
         * @description Returns bytes only after the opaque blob id is ready and attached to this session. Staging, missing and ownership-mismatched blobs all return 404.
         */
        readonly get: operations["getSessionBlob"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/compact": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /** Force context compaction */
        readonly post: operations["compactSession"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/events": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Replay and follow a session event stream
         * @description Persisted events use their per-session seq as the SSE id. Last-Event-ID is equivalent to the after query parameter.
         */
        readonly get: operations["subscribeEvents"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/items": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List durable items in a session */
        readonly get: operations["listItems"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/items/{itemId}/output": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Fetch an offloaded tool output
         * @description Resolves an item's opaque output blob only for the exact tenant, user, session and item owner. Missing, non-ready and ownership-mismatched outputs return 404.
         */
        readonly get: operations["getItemOutput"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/resume": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /** Fetch the state required to resume a client */
        readonly post: operations["resumeSession"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/turns": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List turns in a session */
        readonly get: operations["listTurns"];
        readonly put?: never;
        /**
         * Start or steer a turn
         * @description A new streaming turn returns SSE. A non-streaming request returns 202 JSON. A completed idempotency replay always returns 200 JSON.
         */
        readonly post: operations["startTurn"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/turns/{turnId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Get a turn */
        readonly get: operations["getTurn"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/turns/{turnId}/interrupt": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /** Interrupt a running turn */
        readonly post: operations["interruptTurn"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/turns/{turnId}/steer": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /** Inject user input into a running turn */
        readonly post: operations["steerTurn"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/turns/{turnId}/tool-results": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /** Return a result for a client-executed dynamic tool */
        readonly post: operations["submitDynamicToolResult"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/sessions/{id}/unarchive": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Restore an archived session
         * @description Idempotently returns an archived session to the visible, writable state through the lease/fence path.
         */
        readonly post: operations["unarchiveSession"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/tenant-erasure-requests": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Admit and logically fence a tenant for future erasure
         * @description Platform-operator-only. New admission is fleet-gated and atomically creates the tenant admission, logical credential fence and first audit event. While admission is closed, an exact already-committed Idempotency-Key replay remains recoverable but can never create a gate. T2 does not claim that a tenant worker exists or that physical credential/content deletion is complete.
         */
        readonly post: operations["requestTenantErasure"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/tenant-erasure-requests/{requestId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Read a tenant erasure request
         * @description Uses the independent platform operator credential and remains available when new tenant-erasure admission is closed.
         */
        readonly get: operations["getTenantErasureRequest"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/tenant/api-keys": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List API key records without key material */
        readonly get: operations["listApiKeys"];
        readonly put?: never;
        /**
         * Create an API key
         * @description The plaintext key is returned exactly once and is never stored by the service.
         */
        readonly post: operations["createApiKey"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/tenant/api-keys/{keyId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        /** Revoke an API key */
        readonly delete: operations["revokeApiKey"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/tenant/auth": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Read the tenant end-user authentication policy */
        readonly get: operations["getTenantAuth"];
        /** Replace the tenant end-user authentication policy */
        readonly put: operations["updateTenantAuth"];
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/tools": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List tools visible to the runner */
        readonly get: operations["listTools"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/v1/usage": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Query normalized usage ledger rollups
         * @description A user identity confines results to that user. Tenant-wide and group-by-user views require an admin-scoped key.
         */
        readonly get: operations["queryUsage"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        readonly ActiveLegalHoldList: {
            readonly control: {
                readonly activeHoldCount: number;
                readonly activeProjectionSha256: string;
                readonly controlGeneration: number;
                readonly subjectId: string;
                /** @enum {string} */
                readonly subjectKind: "tenant" | "user";
                readonly tenantId: string;
                readonly updatedAtMs: number;
            };
            readonly data: readonly {
                readonly createdAtMs: number;
                readonly createdByKeyId: string;
                readonly createdControlGeneration: number;
                readonly externalReferenceSha256?: string;
                readonly holdId: string;
                /** @enum {string} */
                readonly reasonCode: "litigation" | "regulatory" | "security_incident" | "billing_dispute" | "legacy_unattributed";
                readonly releasedAtMs?: number;
                readonly releasedByKeyId?: string;
                readonly releasedControlGeneration?: number;
                /** @enum {string} */
                readonly releaseReasonCode?: "matter_closed" | "issued_in_error" | "superseded";
                /** @enum {string} */
                readonly state: "active" | "released";
                readonly subjectId: string;
                /** @enum {string} */
                readonly subjectKind: "tenant" | "user";
                readonly tenantId: string;
            }[];
        };
        readonly ActiveRetentionPolicy: {
            readonly control: {
                readonly activePolicySha256?: string;
                readonly activePolicyVersion?: string;
                readonly controlGeneration: number;
                readonly effectiveAtMs?: number;
                readonly tenantId: string;
                readonly updatedAtMs: number;
            };
            readonly policy: {
                readonly createdAtMs: number;
                readonly createdByKeyId: string;
                readonly policy: {
                    /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                    readonly billingFactRetentionMs: number | null;
                    /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                    readonly exportArtifactTtlMs: number | null;
                    /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                    readonly idempotencyReceiptRetentionMs: number | null;
                    /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                    readonly lifecycleAuditRetentionMs: number | null;
                    /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                    readonly operationalUsageRetentionMs: number | null;
                    /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                    readonly sessionContentRetentionMs: number | null;
                    /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                    readonly userErasureGraceMs: number | null;
                };
                readonly policySha256: string;
                readonly policyVersion: string;
                /** @enum {number} */
                readonly schemaVersion: 1;
                readonly tenantId: string;
            };
        };
        readonly AgentDefinition: {
            /** @enum {string} */
            readonly approvalPolicy: "untrusted" | "on-request" | "never";
            /** @enum {string} */
            readonly busyPolicy: "steer" | "reject";
            readonly createdAtMs: number;
            readonly description?: string;
            readonly id: string;
            readonly instructions: string;
            readonly limits: {
                readonly maxCostCNY?: number;
                readonly maxOutputTokensPerStep?: number;
                readonly maxSteps?: number;
                readonly maxToolCalls?: number;
                readonly maxWallClockMs?: number;
            };
            /** @description Persisted extension ids; inactive while capabilities.mcp is empty. */
            readonly mcpServers: readonly string[];
            readonly metadata: {
                readonly [key: string]: unknown;
            };
            readonly model: {
                readonly model: string;
                readonly provider: string;
                /** @enum {string} */
                readonly reasoning?: "off" | "low" | "medium" | "high";
            };
            readonly name: string;
            /** @enum {string} */
            readonly sandbox: "none";
            /** @description Persisted skill ids; inactive while capabilities.skills is false. */
            readonly skills: readonly string[];
            readonly tenantId: string;
            readonly tools: readonly string[];
            readonly version: number;
        };
        readonly AgentDefinitionRequest: {
            /**
             * @default on-request
             * @enum {string}
             */
            readonly approvalPolicy?: "untrusted" | "on-request" | "never";
            /**
             * @default steer
             * @enum {string}
             */
            readonly busyPolicy?: "steer" | "reject";
            readonly description?: string;
            /** @default  */
            readonly instructions?: string;
            /** @default {} */
            readonly limits?: {
                readonly maxCostCNY?: number;
                readonly maxOutputTokensPerStep?: number;
                readonly maxSteps?: number;
                readonly maxToolCalls?: number;
                readonly maxWallClockMs?: number;
            };
            /**
             * @description Reserved for M3. The current service requires this array to be empty.
             * @default []
             */
            readonly mcpServers?: readonly string[];
            /** @default {} */
            readonly metadata?: {
                readonly [key: string]: unknown;
            };
            readonly model: {
                readonly model: string;
                readonly provider: string;
                /** @enum {string} */
                readonly reasoning?: "off" | "low" | "medium" | "high";
            };
            readonly name: string;
            /**
             * @default none
             * @enum {string}
             */
            readonly sandbox?: "none";
            /**
             * @description Reserved for M3. The current service requires this array to be empty.
             * @default []
             */
            readonly skills?: readonly string[];
            /** @default [] */
            readonly tools?: readonly string[];
        };
        readonly AgentPage: {
            readonly data: readonly {
                /** @enum {string} */
                readonly approvalPolicy: "untrusted" | "on-request" | "never";
                /** @enum {string} */
                readonly busyPolicy: "steer" | "reject";
                readonly createdAtMs: number;
                readonly description?: string;
                readonly id: string;
                readonly instructions: string;
                readonly limits: {
                    readonly maxCostCNY?: number;
                    readonly maxOutputTokensPerStep?: number;
                    readonly maxSteps?: number;
                    readonly maxToolCalls?: number;
                    readonly maxWallClockMs?: number;
                };
                /** @description Persisted extension ids; inactive while capabilities.mcp is empty. */
                readonly mcpServers: readonly string[];
                readonly metadata: {
                    readonly [key: string]: unknown;
                };
                readonly model: {
                    readonly model: string;
                    readonly provider: string;
                    /** @enum {string} */
                    readonly reasoning?: "off" | "low" | "medium" | "high";
                };
                readonly name: string;
                /** @enum {string} */
                readonly sandbox: "none";
                /** @description Persisted skill ids; inactive while capabilities.skills is false. */
                readonly skills: readonly string[];
                readonly tenantId: string;
                readonly tools: readonly string[];
                readonly version: number;
            }[];
            readonly nextCursor: string | null;
        };
        readonly ApiKeyList: {
            readonly data: readonly {
                readonly createdAtMs: number;
                readonly keyId: string;
                readonly revokedAtMs?: number;
                readonly scopes: readonly ("runtime" | "admin")[];
                readonly tenantId: string;
            }[];
        };
        readonly Approval: {
            readonly args?: unknown;
            readonly availableDecisions: readonly ("accept" | "acceptForSession" | "decline" | "cancel")[];
            readonly createdAtMs: number;
            readonly decidedBy?: string;
            /** @enum {string} */
            readonly decision?: "accept" | "acceptForSession" | "decline" | "cancel";
            readonly expiresAtMs: number;
            readonly id: string;
            readonly itemId: string;
            readonly reason?: string;
            readonly resolvedAtMs?: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly status: "pending" | "resolved" | "expired";
            readonly toolCallId: string;
            readonly toolName: string;
            readonly turnId: string;
        };
        readonly ApprovalListResponse: {
            readonly data: readonly {
                readonly args?: unknown;
                readonly availableDecisions: readonly ("accept" | "acceptForSession" | "decline" | "cancel")[];
                readonly createdAtMs: number;
                readonly decidedBy?: string;
                /** @enum {string} */
                readonly decision?: "accept" | "acceptForSession" | "decline" | "cancel";
                readonly expiresAtMs: number;
                readonly id: string;
                readonly itemId: string;
                readonly reason?: string;
                readonly resolvedAtMs?: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "pending" | "resolved" | "expired";
                readonly toolCallId: string;
                readonly toolName: string;
                readonly turnId: string;
            }[];
        };
        readonly ApprovalResponseRequest: {
            /** @enum {string} */
            readonly decision: "accept" | "acceptForSession" | "decline" | "cancel";
        };
        readonly BlobUploadResponse: {
            readonly blobId: string;
            /** @enum {string} */
            readonly contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
            readonly expiresAtMs: number;
            /** @enum {string} */
            readonly purpose: "input_image";
            readonly sizeBytes: number;
            /** @enum {string} */
            readonly state: "staging";
        };
        readonly Capabilities: {
            readonly features: {
                /** @enum {boolean} */
                readonly approvals: true;
                /** @default false */
                readonly blobAttachments?: boolean;
                readonly byok: boolean;
                /** @default false */
                readonly dataErasureRequests?: boolean;
                /** @default false */
                readonly dataExportRequests?: boolean;
                /** @default [] */
                readonly dataGovernance?: readonly ("canonical-retention-v1" | "multi-legal-hold-v1")[];
                /** @default false */
                readonly dataGovernanceManagement?: boolean;
                /**
                 * @default false
                 * @enum {boolean}
                 */
                readonly dataPurgeExecution?: false;
                readonly dynamicTools: boolean;
                /** @default [] */
                readonly erasureJobControl?: readonly ("quarantine-v1" | "legacy-tombstone-compensation-v1")[];
                readonly mcp: readonly ("streamable-http" | "stdio")[];
                /** @default [] */
                readonly purgePolicyEvaluation?: readonly "policy-evaluator-v1"[];
                readonly replay: {
                    readonly hotWindowMs: number;
                    /** @enum {boolean} */
                    readonly persistedEvents: true;
                };
                readonly sandbox: readonly "none"[];
                readonly sessionLifecycle: readonly ("archive" | "unarchive" | "tombstone" | "purge")[];
                readonly skills: boolean;
                /** @enum {boolean} */
                readonly streaming: true;
                /** @default [] */
                readonly tenantCredentialRevocation?: readonly "credential-store-v1"[];
                /** @default false */
                readonly tenantCredentialRevocationWorker?: boolean;
                /** @default false */
                readonly tenantDatabasePurgeWorker?: boolean;
                /** @default [] */
                readonly tenantErasureControl?: readonly "platform-control-v1"[];
                /** @default false */
                readonly tenantErasureRequests?: boolean;
                /** @default [] */
                readonly tenantPurgeExecution?: readonly ("local-execution-ack-v1" | "local-db-content-delete-v1")[];
                /** @default false */
                readonly tenantPurgeExecutionWorker?: boolean;
                /** @default [] */
                readonly tenantRedisPurge?: readonly "session-state-delete-v1"[];
                /** @default null */
                readonly tenantRedisPurgeNamespaceSha256?: string | null;
                /** @default false */
                readonly tenantRedisPurgeWorker?: boolean;
                /** @default [] */
                readonly tenantRuntimeDrain?: readonly "runtime-drain-v1"[];
                /** @default false */
                readonly tenantRuntimeDrainEndpoint?: boolean;
                /** @default [] */
                readonly userDataExport?: readonly "artifact-ndjson-v1"[];
                /** @default [] */
                readonly userErasureWorker?: readonly "drain-v1"[];
            };
            /** @enum {string} */
            readonly protocolVersion: "2026-10-08";
            /** @enum {string} */
            readonly service: "agent-runner" | "agent-router";
        };
        readonly CompactSessionResponse: {
            readonly compacted: boolean;
            readonly summaryItemId?: string;
        };
        readonly CreateApiKeyRequest: {
            readonly keyId: string;
            /**
             * @default [
             *       "runtime"
             *     ]
             */
            readonly scopes?: readonly ("runtime" | "admin")[];
        };
        readonly CreateApiKeyResponse: {
            readonly key: string;
            readonly keyId: string;
            readonly scopes: readonly ("runtime" | "admin")[];
        };
        readonly CreateSessionRequest: {
            readonly agentId: string;
            readonly agentVersion?: number;
            /** @default {} */
            readonly metadata?: {
                readonly [key: string]: unknown;
            };
            readonly parentSessionId?: string;
            readonly title?: string;
            readonly userId?: string;
        };
        readonly DataExportRequest: {
            readonly createdAtMs: number;
            /** @enum {string} */
            readonly format: "ndjson-v1";
            readonly id: string;
            /** @enum {string} */
            readonly scope: "user";
            /** @enum {string} */
            readonly status: "queued";
            readonly updatedAtMs: number;
            readonly userId: string;
        } | {
            readonly createdAtMs: number;
            /** @enum {string} */
            readonly format: "ndjson-v1";
            readonly id: string;
            /** @enum {string} */
            readonly scope: "user";
            /** @enum {string} */
            readonly status: "building";
            readonly updatedAtMs: number;
            readonly userId: string;
        } | {
            readonly artifact: {
                /** @enum {string} */
                readonly contentType: "application/vnd.agent-service.user-export+ndjson";
                readonly sha256: string;
                readonly sizeBytes: number;
            };
            readonly createdAtMs: number;
            readonly expiresAtMs: number;
            /** @enum {string} */
            readonly format: "ndjson-v1";
            readonly id: string;
            readonly readyAtMs: number;
            /** @enum {string} */
            readonly scope: "user";
            readonly snapshotAtMs: number;
            /** @enum {string} */
            readonly status: "ready";
            readonly updatedAtMs: number;
            readonly userId: string;
        } | {
            readonly createdAtMs: number;
            /** @enum {string} */
            readonly format: "ndjson-v1";
            readonly id: string;
            /** @enum {string} */
            readonly scope: "user";
            /** @enum {string} */
            readonly status: "failed";
            readonly updatedAtMs: number;
            readonly userId: string;
        } | {
            readonly createdAtMs: number;
            /** @enum {string} */
            readonly format: "ndjson-v1";
            readonly id: string;
            /** @enum {string} */
            readonly scope: "user";
            /** @enum {string} */
            readonly status: "expired";
            readonly updatedAtMs: number;
            readonly userId: string;
        } | {
            readonly createdAtMs: number;
            /** @enum {string} */
            readonly format: "ndjson-v1";
            readonly id: string;
            /** @enum {string} */
            readonly scope: "user";
            /** @enum {string} */
            readonly status: "revoked";
            readonly updatedAtMs: number;
            readonly userId: string;
        };
        readonly DynamicToolResultRequest: {
            readonly content: readonly {
                readonly text: string;
                /** @enum {string} */
                readonly type: "text";
            }[];
            /** @default false */
            readonly isError?: boolean;
            readonly toolCallId: string;
        };
        readonly ErasureRequest: {
            readonly createdAtMs: number;
            readonly generation: number;
            readonly id: string;
            /** @enum {string} */
            readonly scope: "user";
            /** @enum {string} */
            readonly status: "gated" | "draining" | "tombstoning" | "reconciling_usage" | "awaiting_purge_policy" | "purging" | "blocked" | "completed";
            readonly updatedAtMs: number;
            readonly userId: string;
        };
        readonly ErrorBody: {
            readonly error: {
                /** @enum {string} */
                readonly code: "invalid_request" | "unauthorized" | "forbidden" | "not_found" | "session_busy" | "session_archived" | "session_has_children" | "subject_deleting" | "session_lease_conflict" | "idempotency_conflict" | "state_conflict" | "provider_error" | "approval_expired" | "draining" | "internal_error";
                readonly details?: unknown;
                readonly message: string;
                readonly retryable?: boolean;
            };
        };
        readonly Event: {
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "session/created";
        } | {
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            readonly status: {
                /** @enum {string} */
                readonly type: "idle";
            } | {
                /** @default [] */
                readonly activeFlags?: readonly ("waitingOnApproval" | "waitingOnUserInput")[];
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "active";
            } | {
                readonly message: string;
                /** @enum {string} */
                readonly type: "error";
            };
            /** @enum {string} */
            readonly type: "session/status/changed";
        } | {
            readonly emittedAtMs: number;
            readonly itemId: string;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "session/compacted";
        } | {
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "session/archived";
        } | {
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "session/unarchived";
        } | {
            readonly deletionGeneration: number;
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "session/deleted";
        } | {
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            readonly turn: {
                readonly completedAtMs?: number;
                readonly error?: {
                    readonly code: string;
                    readonly message: string;
                };
                readonly id: string;
                readonly idempotencyKey?: string;
                readonly metadata?: {
                    readonly [key: string]: unknown;
                };
                readonly model?: {
                    readonly model: string;
                    readonly provider: string;
                    /** @enum {string} */
                    readonly reasoning?: "off" | "low" | "medium" | "high";
                };
                readonly partialText?: string;
                readonly seqEnd?: number;
                readonly seqStart: number;
                readonly sessionId: string;
                readonly startedAtMs: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "interrupted" | "failed";
                /** @default 0 */
                readonly steps?: number;
                /** @enum {string} */
                readonly stopReason?: "end_turn" | "max_steps" | "max_tool_calls" | "max_cost" | "max_wall_clock" | "max_output_tokens" | "interrupted" | "error";
                /** @default 0 */
                readonly toolCalls?: number;
                readonly usage: {
                    /** @default 0 */
                    readonly cacheReadTokens?: number;
                    /** @default 0 */
                    readonly cacheWriteTokens?: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    /** @default 0 */
                    readonly reasoningTokens?: number;
                    readonly totalTokens: number;
                };
            };
            /** @enum {string} */
            readonly type: "turn/started";
        } | {
            readonly emittedAtMs: number;
            readonly itemId: string;
            readonly seq: number;
            readonly sessionId: string;
            readonly turnId: string;
            /** @enum {string} */
            readonly type: "turn/steered";
        } | {
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly stopReason: "end_turn" | "max_steps" | "max_tool_calls" | "max_cost" | "max_wall_clock" | "max_output_tokens" | "interrupted" | "error";
            readonly turn: {
                readonly completedAtMs?: number;
                readonly error?: {
                    readonly code: string;
                    readonly message: string;
                };
                readonly id: string;
                readonly idempotencyKey?: string;
                readonly metadata?: {
                    readonly [key: string]: unknown;
                };
                readonly model?: {
                    readonly model: string;
                    readonly provider: string;
                    /** @enum {string} */
                    readonly reasoning?: "off" | "low" | "medium" | "high";
                };
                readonly partialText?: string;
                readonly seqEnd?: number;
                readonly seqStart: number;
                readonly sessionId: string;
                readonly startedAtMs: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "interrupted" | "failed";
                /** @default 0 */
                readonly steps?: number;
                /** @enum {string} */
                readonly stopReason?: "end_turn" | "max_steps" | "max_tool_calls" | "max_cost" | "max_wall_clock" | "max_output_tokens" | "interrupted" | "error";
                /** @default 0 */
                readonly toolCalls?: number;
                readonly usage: {
                    /** @default 0 */
                    readonly cacheReadTokens?: number;
                    /** @default 0 */
                    readonly cacheWriteTokens?: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    /** @default 0 */
                    readonly reasoningTokens?: number;
                    readonly totalTokens: number;
                };
            };
            /** @enum {string} */
            readonly type: "turn/completed";
        } | {
            readonly emittedAtMs: number;
            readonly item: {
                readonly completedAtMs?: number;
                readonly content: readonly ({
                    readonly text: string;
                    /** @enum {string} */
                    readonly type: "text";
                } | {
                    readonly blobId: string;
                    /** @enum {string} */
                    readonly mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                    /** @enum {string} */
                    readonly type: "image";
                } | {
                    readonly args?: string;
                    readonly name: string;
                    /** @enum {string} */
                    readonly type: "skill";
                } | {
                    readonly name: string;
                    /** @enum {string} */
                    readonly type: "mention";
                })[];
                readonly createdAtMs: number;
                readonly id: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "userMessage";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /**
                 * @default finalAnswer
                 * @enum {string}
                 */
                readonly phase?: "commentary" | "finalAnswer";
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "agentMessage";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "reasoning";
            } | {
                readonly args?: unknown;
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /** @enum {string} */
                readonly kind: "builtin" | "mcp" | "dynamic" | "skill";
                readonly name: string;
                readonly seq: number;
                readonly sessionId: string;
                readonly startedAtMs?: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "toolCall";
            } | {
                readonly completedAtMs?: number;
                readonly content: readonly ({
                    readonly text: string;
                    /** @enum {string} */
                    readonly type: "text";
                } | {
                    readonly mimeType?: string;
                    /** @enum {string} */
                    readonly type: "image";
                    readonly url: string;
                })[];
                readonly createdAtMs: number;
                readonly details?: unknown;
                readonly id: string;
                /** @default false */
                readonly isError?: boolean;
                readonly name: string;
                readonly outputRef?: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "toolResult";
            } | {
                readonly approvalId: string;
                readonly args?: unknown;
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly name: string;
                readonly reason?: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "approvalRequest";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly replacesUpToSeq: number;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly summary: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "contextCompaction";
                readonly usageSnapshot?: {
                    /** @default 0 */
                    readonly cacheReadTokens?: number;
                    /** @default 0 */
                    readonly cacheWriteTokens?: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    /** @default 0 */
                    readonly reasoningTokens?: number;
                    readonly totalTokens: number;
                };
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /** @enum {string} */
                readonly kind: "toolsChanged" | "steer" | "recovery" | "limitReached";
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "systemNotice";
            };
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "item/started";
        } | {
            readonly emittedAtMs: number;
            readonly item: {
                readonly completedAtMs?: number;
                readonly content: readonly ({
                    readonly text: string;
                    /** @enum {string} */
                    readonly type: "text";
                } | {
                    readonly blobId: string;
                    /** @enum {string} */
                    readonly mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                    /** @enum {string} */
                    readonly type: "image";
                } | {
                    readonly args?: string;
                    readonly name: string;
                    /** @enum {string} */
                    readonly type: "skill";
                } | {
                    readonly name: string;
                    /** @enum {string} */
                    readonly type: "mention";
                })[];
                readonly createdAtMs: number;
                readonly id: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "userMessage";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /**
                 * @default finalAnswer
                 * @enum {string}
                 */
                readonly phase?: "commentary" | "finalAnswer";
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "agentMessage";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "reasoning";
            } | {
                readonly args?: unknown;
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /** @enum {string} */
                readonly kind: "builtin" | "mcp" | "dynamic" | "skill";
                readonly name: string;
                readonly seq: number;
                readonly sessionId: string;
                readonly startedAtMs?: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "toolCall";
            } | {
                readonly completedAtMs?: number;
                readonly content: readonly ({
                    readonly text: string;
                    /** @enum {string} */
                    readonly type: "text";
                } | {
                    readonly mimeType?: string;
                    /** @enum {string} */
                    readonly type: "image";
                    readonly url: string;
                })[];
                readonly createdAtMs: number;
                readonly details?: unknown;
                readonly id: string;
                /** @default false */
                readonly isError?: boolean;
                readonly name: string;
                readonly outputRef?: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "toolResult";
            } | {
                readonly approvalId: string;
                readonly args?: unknown;
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly name: string;
                readonly reason?: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "approvalRequest";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly replacesUpToSeq: number;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly summary: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "contextCompaction";
                readonly usageSnapshot?: {
                    /** @default 0 */
                    readonly cacheReadTokens?: number;
                    /** @default 0 */
                    readonly cacheWriteTokens?: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    /** @default 0 */
                    readonly reasoningTokens?: number;
                    readonly totalTokens: number;
                };
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /** @enum {string} */
                readonly kind: "toolsChanged" | "steer" | "recovery" | "limitReached";
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "systemNotice";
            };
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "item/completed";
        } | {
            readonly approval: {
                readonly args?: unknown;
                readonly availableDecisions: readonly ("accept" | "acceptForSession" | "decline" | "cancel")[];
                readonly createdAtMs: number;
                readonly decidedBy?: string;
                /** @enum {string} */
                readonly decision?: "accept" | "acceptForSession" | "decline" | "cancel";
                readonly expiresAtMs: number;
                readonly id: string;
                readonly itemId: string;
                readonly reason?: string;
                readonly resolvedAtMs?: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "pending" | "resolved" | "expired";
                readonly toolCallId: string;
                readonly toolName: string;
                readonly turnId: string;
            };
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "approval/requested";
        } | {
            readonly approval: {
                readonly args?: unknown;
                readonly availableDecisions: readonly ("accept" | "acceptForSession" | "decline" | "cancel")[];
                readonly createdAtMs: number;
                readonly decidedBy?: string;
                /** @enum {string} */
                readonly decision?: "accept" | "acceptForSession" | "decline" | "cancel";
                readonly expiresAtMs: number;
                readonly id: string;
                readonly itemId: string;
                readonly reason?: string;
                readonly resolvedAtMs?: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "pending" | "resolved" | "expired";
                readonly toolCallId: string;
                readonly toolName: string;
                readonly turnId: string;
            };
            readonly emittedAtMs: number;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "approval/resolved";
        } | {
            readonly emittedAtMs: number;
            readonly runtime: {
                readonly model: string;
                readonly provider: string;
            };
            readonly seq: number;
            readonly sessionId: string;
            readonly sessionUsage: {
                /** @default 0 */
                readonly cacheReadTokens?: number;
                /** @default 0 */
                readonly cacheWriteTokens?: number;
                readonly costCNY?: number;
                readonly inputTokens: number;
                readonly outputTokens: number;
                /** @default 0 */
                readonly reasoningTokens?: number;
                readonly totalTokens: number;
            };
            readonly step: number;
            readonly stepUsage: {
                /** @default 0 */
                readonly cacheReadTokens?: number;
                /** @default 0 */
                readonly cacheWriteTokens?: number;
                readonly costCNY?: number;
                readonly inputTokens: number;
                readonly outputTokens: number;
                /** @default 0 */
                readonly reasoningTokens?: number;
                readonly totalTokens: number;
            };
            readonly turnId: string;
            readonly turnUsage: {
                /** @default 0 */
                readonly cacheReadTokens?: number;
                /** @default 0 */
                readonly cacheWriteTokens?: number;
                readonly costCNY?: number;
                readonly inputTokens: number;
                readonly outputTokens: number;
                /** @default 0 */
                readonly reasoningTokens?: number;
                readonly totalTokens: number;
            };
            /** @enum {string} */
            readonly type: "usage/updated";
        } | {
            readonly code: string;
            readonly emittedAtMs: number;
            readonly message: string;
            readonly seq: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "warning";
        } | {
            readonly code: string;
            readonly emittedAtMs: number;
            readonly message: string;
            readonly seq: number;
            readonly sessionId: string;
            readonly turnId?: string;
            /** @enum {string} */
            readonly type: "error";
        } | {
            readonly delta: string;
            readonly emittedAtMs: number;
            readonly itemId: string;
            readonly sessionId: string;
            readonly turnId: string;
            /** @enum {string} */
            readonly type: "item/agentMessage/delta";
        } | {
            readonly delta: string;
            readonly emittedAtMs: number;
            readonly itemId: string;
            readonly sessionId: string;
            readonly turnId: string;
            /** @enum {string} */
            readonly type: "item/reasoning/delta";
        } | {
            readonly delta: string;
            readonly emittedAtMs: number;
            readonly itemId?: string;
            readonly sessionId: string;
            readonly toolCallId: string;
            readonly turnId: string;
            /** @enum {string} */
            readonly type: "item/toolCall/argsDelta";
        } | {
            readonly emittedAtMs: number;
            readonly sessionId: string;
            /** @enum {string} */
            readonly type: "heartbeat";
        };
        /** @enum {string} */
        readonly ExcludableEventType: "item/reasoning/delta" | "item/toolCall/argsDelta" | "item/agentMessage/delta" | "usage/updated" | "heartbeat";
        readonly ItemListResponse: {
            readonly data: readonly ({
                readonly completedAtMs?: number;
                readonly content: readonly ({
                    readonly text: string;
                    /** @enum {string} */
                    readonly type: "text";
                } | {
                    readonly blobId: string;
                    /** @enum {string} */
                    readonly mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                    /** @enum {string} */
                    readonly type: "image";
                })[];
                readonly createdAtMs: number;
                readonly id: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "userMessage";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /** @enum {string} */
                readonly phase: "commentary" | "finalAnswer";
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "agentMessage";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "reasoning";
            } | {
                readonly args?: unknown;
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /** @enum {string} */
                readonly kind: "builtin" | "mcp" | "dynamic" | "skill";
                readonly name: string;
                readonly seq: number;
                readonly sessionId: string;
                readonly startedAtMs?: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "toolCall";
            } | {
                readonly completedAtMs?: number;
                readonly content: readonly ({
                    readonly text: string;
                    /** @enum {string} */
                    readonly type: "text";
                } | {
                    readonly mimeType?: string;
                    /** @enum {string} */
                    readonly type: "image";
                    readonly url: string;
                })[];
                readonly createdAtMs: number;
                readonly details?: unknown;
                readonly id: string;
                readonly isError: boolean;
                readonly name: string;
                readonly outputRef?: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "toolResult";
            } | {
                readonly approvalId: string;
                readonly args?: unknown;
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly name: string;
                readonly reason?: string;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly toolCallId: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "approvalRequest";
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                readonly replacesUpToSeq: number;
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly summary: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "contextCompaction";
                readonly usageSnapshot?: {
                    readonly cacheReadTokens: number;
                    readonly cacheWriteTokens: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    readonly reasoningTokens: number;
                    readonly totalTokens: number;
                };
            } | {
                readonly completedAtMs?: number;
                readonly createdAtMs: number;
                readonly id: string;
                /** @enum {string} */
                readonly kind: "toolsChanged" | "steer" | "recovery" | "limitReached";
                readonly seq: number;
                readonly sessionId: string;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "failed" | "declined";
                readonly step?: number;
                readonly text: string;
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "systemNotice";
            })[];
        };
        readonly LegalHold: {
            readonly createdAtMs: number;
            readonly createdByKeyId: string;
            readonly createdControlGeneration: number;
            readonly externalReferenceSha256?: string;
            readonly holdId: string;
            /** @enum {string} */
            readonly reasonCode: "litigation" | "regulatory" | "security_incident" | "billing_dispute" | "legacy_unattributed";
            readonly releasedAtMs?: number;
            readonly releasedByKeyId?: string;
            readonly releasedControlGeneration?: number;
            /** @enum {string} */
            readonly releaseReasonCode?: "matter_closed" | "issued_in_error" | "superseded";
            /** @enum {string} */
            readonly state: "active" | "released";
            readonly subjectId: string;
            /** @enum {string} */
            readonly subjectKind: "tenant" | "user";
            readonly tenantId: string;
        };
        readonly LegalHoldReleaseRequest: {
            readonly expectedControlGeneration: number;
            /** @enum {string} */
            readonly reasonCode: "matter_closed" | "issued_in_error" | "superseded";
        };
        readonly LegalHoldSetRequest: {
            readonly expectedControlGeneration: number;
            readonly externalReferenceSha256?: string;
            readonly holdId: string;
            /** @enum {string} */
            readonly reasonCode: "litigation" | "regulatory" | "security_incident" | "billing_dispute";
            readonly subjectId: string;
            /** @enum {string} */
            readonly subjectKind: "tenant" | "user";
        };
        readonly ModelList: {
            readonly data: readonly {
                readonly compat?: {
                    /** @enum {string} */
                    readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
                    readonly requiresAssistantAfterToolResult?: boolean;
                    readonly requiresReasoningContentOnAssistantMessages?: boolean;
                    readonly requiresToolResultName?: boolean;
                    readonly supportsDeveloperRole?: boolean;
                    readonly supportsJsonSchema?: boolean;
                    readonly supportsReasoningEffort?: boolean;
                    readonly supportsStore?: boolean;
                    readonly supportsUsageInStreaming?: boolean;
                    /** @enum {string} */
                    readonly thinkingFormat?: "openai" | "deepseek" | "qwen" | "zai" | "openrouter";
                };
                readonly contextWindow: number;
                readonly id: string;
                readonly input: readonly [
                    "text"
                ] | readonly [
                    "text",
                    "image"
                ] | readonly [
                    "image",
                    "text"
                ];
                readonly maxOutputTokens: number;
                readonly name?: string;
                readonly price?: {
                    readonly cacheRead: number;
                    readonly cacheWrite: number;
                    readonly input: number;
                    readonly output: number;
                };
                readonly provider: string;
                readonly reasoning: boolean;
            }[];
        };
        readonly OkResponse: {
            /** @enum {boolean} */
            readonly ok: true;
        };
        readonly OpenApiDocument: {
            readonly info: {
                readonly title: string;
                readonly version: string;
            };
            readonly openapi: string;
            readonly paths: {
                readonly [key: string]: unknown;
            };
        };
        readonly ProviderConfig: {
            /** @enum {string} */
            readonly api: "openai-completions";
            readonly apiKeyRef?: string;
            /**
             * Format: uri
             * @description Public HTTP(S) provider endpoint. The runner resolves and rejects loopback, private, link-local, and otherwise non-public hosts before storing it.
             */
            readonly baseUrl: string;
            readonly compat?: {
                /** @enum {string} */
                readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
                readonly requiresAssistantAfterToolResult?: boolean;
                readonly requiresReasoningContentOnAssistantMessages?: boolean;
                readonly requiresToolResultName?: boolean;
                readonly supportsDeveloperRole?: boolean;
                readonly supportsJsonSchema?: boolean;
                readonly supportsReasoningEffort?: boolean;
                readonly supportsStore?: boolean;
                readonly supportsUsageInStreaming?: boolean;
                /** @enum {string} */
                readonly thinkingFormat?: "openai" | "deepseek" | "qwen" | "zai" | "openrouter";
            };
            readonly createdAtMs: number;
            readonly fallback: readonly string[];
            readonly headers: {
                readonly [key: string]: string;
            };
            readonly id: string;
            readonly models: readonly {
                readonly compat?: {
                    /** @enum {string} */
                    readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
                    readonly requiresAssistantAfterToolResult?: boolean;
                    readonly requiresReasoningContentOnAssistantMessages?: boolean;
                    readonly requiresToolResultName?: boolean;
                    readonly supportsDeveloperRole?: boolean;
                    readonly supportsJsonSchema?: boolean;
                    readonly supportsReasoningEffort?: boolean;
                    readonly supportsStore?: boolean;
                    readonly supportsUsageInStreaming?: boolean;
                    /** @enum {string} */
                    readonly thinkingFormat?: "openai" | "deepseek" | "qwen" | "zai" | "openrouter";
                };
                readonly contextWindow: number;
                readonly id: string;
                readonly input: readonly [
                    "text"
                ] | readonly [
                    "text",
                    "image"
                ] | readonly [
                    "image",
                    "text"
                ];
                readonly maxOutputTokens: number;
                readonly name?: string;
                readonly price?: {
                    readonly cacheRead: number;
                    readonly cacheWrite: number;
                    readonly input: number;
                    readonly output: number;
                };
                readonly reasoning: boolean;
            }[];
            readonly name?: string;
            readonly quota: {
                readonly concurrency?: number;
                readonly rpm?: number;
            };
            readonly tenantId: string;
            readonly updatedAtMs: number;
        };
        readonly ProviderList: {
            readonly data: readonly {
                /** @enum {string} */
                readonly api: "openai-completions";
                readonly apiKeyRef?: string;
                /**
                 * Format: uri
                 * @description Public HTTP(S) provider endpoint. The runner resolves and rejects loopback, private, link-local, and otherwise non-public hosts before storing it.
                 */
                readonly baseUrl: string;
                readonly compat?: {
                    /** @enum {string} */
                    readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
                    readonly requiresAssistantAfterToolResult?: boolean;
                    readonly requiresReasoningContentOnAssistantMessages?: boolean;
                    readonly requiresToolResultName?: boolean;
                    readonly supportsDeveloperRole?: boolean;
                    readonly supportsJsonSchema?: boolean;
                    readonly supportsReasoningEffort?: boolean;
                    readonly supportsStore?: boolean;
                    readonly supportsUsageInStreaming?: boolean;
                    /** @enum {string} */
                    readonly thinkingFormat?: "openai" | "deepseek" | "qwen" | "zai" | "openrouter";
                };
                readonly createdAtMs: number;
                readonly fallback: readonly string[];
                readonly headers: {
                    readonly [key: string]: string;
                };
                readonly id: string;
                readonly models: readonly {
                    readonly compat?: {
                        /** @enum {string} */
                        readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
                        readonly requiresAssistantAfterToolResult?: boolean;
                        readonly requiresReasoningContentOnAssistantMessages?: boolean;
                        readonly requiresToolResultName?: boolean;
                        readonly supportsDeveloperRole?: boolean;
                        readonly supportsJsonSchema?: boolean;
                        readonly supportsReasoningEffort?: boolean;
                        readonly supportsStore?: boolean;
                        readonly supportsUsageInStreaming?: boolean;
                        /** @enum {string} */
                        readonly thinkingFormat?: "openai" | "deepseek" | "qwen" | "zai" | "openrouter";
                    };
                    readonly contextWindow: number;
                    readonly id: string;
                    readonly input: readonly [
                        "text"
                    ] | readonly [
                        "text",
                        "image"
                    ] | readonly [
                        "image",
                        "text"
                    ];
                    readonly maxOutputTokens: number;
                    readonly name?: string;
                    readonly price?: {
                        readonly cacheRead: number;
                        readonly cacheWrite: number;
                        readonly input: number;
                        readonly output: number;
                    };
                    readonly reasoning: boolean;
                }[];
                readonly name?: string;
                readonly quota: {
                    readonly concurrency?: number;
                    readonly rpm?: number;
                };
                readonly tenantId: string;
                readonly updatedAtMs: number;
            }[];
        };
        readonly ResumeSessionResponse: {
            readonly lastSeq: number;
            readonly pendingApprovalIds: readonly string[];
            readonly recentTurns: readonly {
                readonly completedAtMs?: number;
                readonly error?: {
                    readonly code: string;
                    readonly message: string;
                };
                readonly id: string;
                readonly idempotencyKey?: string;
                readonly metadata?: {
                    readonly [key: string]: unknown;
                };
                readonly model?: {
                    readonly model: string;
                    readonly provider: string;
                    /** @enum {string} */
                    readonly reasoning?: "off" | "low" | "medium" | "high";
                };
                readonly partialText?: string;
                readonly seqEnd?: number;
                readonly seqStart: number;
                readonly sessionId: string;
                readonly startedAtMs: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "interrupted" | "failed";
                readonly steps: number;
                /** @enum {string} */
                readonly stopReason?: "end_turn" | "max_steps" | "max_tool_calls" | "max_cost" | "max_wall_clock" | "max_output_tokens" | "interrupted" | "error";
                readonly toolCalls: number;
                readonly usage: {
                    readonly cacheReadTokens: number;
                    readonly cacheWriteTokens: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    readonly reasoningTokens: number;
                    readonly totalTokens: number;
                };
            }[];
            readonly session: {
                readonly agentId: string;
                readonly agentVersion: number;
                readonly archivedAtMs?: number;
                readonly autoApprovedTools: readonly string[];
                readonly contextEpoch: string;
                readonly createdAtMs: number;
                readonly fenceToken: number;
                readonly id: string;
                readonly lastCompactionSeq?: number;
                readonly lastSeq: number;
                readonly metadata: {
                    readonly [key: string]: unknown;
                };
                readonly parentSessionId?: string;
                readonly status: {
                    /** @enum {string} */
                    readonly type: "idle";
                } | {
                    readonly activeFlags: readonly ("waitingOnApproval" | "waitingOnUserInput")[];
                    readonly turnId: string;
                    /** @enum {string} */
                    readonly type: "active";
                } | {
                    readonly message: string;
                    /** @enum {string} */
                    readonly type: "error";
                };
                readonly tenantId: string;
                readonly title?: string;
                readonly updatedAtMs: number;
                readonly usage: {
                    readonly cacheReadTokens: number;
                    readonly cacheWriteTokens: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    readonly reasoningTokens: number;
                    readonly totalTokens: number;
                };
                readonly userId: string;
            };
        };
        readonly RetentionPolicy: {
            readonly createdAtMs: number;
            readonly createdByKeyId: string;
            readonly policy: {
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly billingFactRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly exportArtifactTtlMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly idempotencyReceiptRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly lifecycleAuditRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly operationalUsageRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly sessionContentRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly userErasureGraceMs: number | null;
            };
            readonly policySha256: string;
            readonly policyVersion: string;
            /** @enum {number} */
            readonly schemaVersion: 1;
            readonly tenantId: string;
        };
        readonly RetentionPolicyActivateRequest: {
            readonly expectedControlGeneration: number;
        };
        readonly RetentionPolicyPutRequest: {
            readonly policy: {
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly billingFactRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly exportArtifactTtlMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly idempotencyReceiptRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly lifecycleAuditRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly operationalUsageRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly sessionContentRetentionMs: number | null;
                /** @description Retention duration in milliseconds. null is fail-closed and does not authorize expiry. */
                readonly userErasureGraceMs: number | null;
            };
        };
        readonly Session: {
            readonly agentId: string;
            readonly agentVersion: number;
            readonly archivedAtMs?: number;
            readonly autoApprovedTools: readonly string[];
            readonly contextEpoch: string;
            readonly createdAtMs: number;
            readonly fenceToken: number;
            readonly id: string;
            readonly lastCompactionSeq?: number;
            readonly lastSeq: number;
            readonly metadata: {
                readonly [key: string]: unknown;
            };
            readonly parentSessionId?: string;
            readonly status: {
                /** @enum {string} */
                readonly type: "idle";
            } | {
                readonly activeFlags: readonly ("waitingOnApproval" | "waitingOnUserInput")[];
                readonly turnId: string;
                /** @enum {string} */
                readonly type: "active";
            } | {
                readonly message: string;
                /** @enum {string} */
                readonly type: "error";
            };
            readonly tenantId: string;
            readonly title?: string;
            readonly updatedAtMs: number;
            readonly usage: {
                readonly cacheReadTokens: number;
                readonly cacheWriteTokens: number;
                readonly costCNY?: number;
                readonly inputTokens: number;
                readonly outputTokens: number;
                readonly reasoningTokens: number;
                readonly totalTokens: number;
            };
            readonly userId: string;
        };
        readonly SessionPage: {
            readonly data: readonly {
                readonly agentId: string;
                readonly agentVersion: number;
                readonly archivedAtMs?: number;
                readonly autoApprovedTools: readonly string[];
                readonly contextEpoch: string;
                readonly createdAtMs: number;
                readonly fenceToken: number;
                readonly id: string;
                readonly lastCompactionSeq?: number;
                readonly lastSeq: number;
                readonly metadata: {
                    readonly [key: string]: unknown;
                };
                readonly parentSessionId?: string;
                readonly status: {
                    /** @enum {string} */
                    readonly type: "idle";
                } | {
                    readonly activeFlags: readonly ("waitingOnApproval" | "waitingOnUserInput")[];
                    readonly turnId: string;
                    /** @enum {string} */
                    readonly type: "active";
                } | {
                    readonly message: string;
                    /** @enum {string} */
                    readonly type: "error";
                };
                readonly tenantId: string;
                readonly title?: string;
                readonly updatedAtMs: number;
                readonly usage: {
                    readonly cacheReadTokens: number;
                    readonly cacheWriteTokens: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    readonly reasoningTokens: number;
                    readonly totalTokens: number;
                };
                readonly userId: string;
            }[];
            readonly nextCursor: string | null;
        };
        readonly StartTurnRequest: {
            /** @enum {string} */
            readonly busyPolicy?: "steer" | "reject";
            readonly dynamicTools?: readonly {
                readonly description: string;
                readonly name: string;
                readonly parameters: {
                    readonly [key: string]: unknown;
                };
            }[];
            readonly input: readonly ({
                readonly text: string;
                /** @enum {string} */
                readonly type: "text";
            } | {
                readonly blobId: string;
                /** @enum {string} */
                readonly mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                /** @enum {string} */
                readonly type: "image";
            })[];
            readonly limits?: {
                readonly maxCostCNY?: number;
                readonly maxOutputTokensPerStep?: number;
                readonly maxSteps?: number;
                readonly maxToolCalls?: number;
                readonly maxWallClockMs?: number;
            };
            /** @default {} */
            readonly metadata?: {
                readonly [key: string]: unknown;
            };
            readonly model?: {
                readonly model?: string;
                readonly provider?: string;
                /** @enum {string} */
                readonly reasoning?: "off" | "low" | "medium" | "high";
            };
            /** @default true */
            readonly stream?: boolean;
        };
        readonly SteerRequest: {
            readonly expectedTurnId?: string;
            readonly input: readonly ({
                readonly text: string;
                /** @enum {string} */
                readonly type: "text";
            } | {
                readonly blobId: string;
                /** @enum {string} */
                readonly mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                /** @enum {string} */
                readonly type: "image";
            })[];
        };
        readonly TenantAuthState: {
            readonly hasSecret: boolean;
            readonly policy: {
                /** @enum {string} */
                readonly mode: "trusted_caller";
            } | {
                /** @enum {string} */
                readonly mode: "end_user_token";
                /**
                 * @description Non-reserved HTTP header carrying the inbound end-user token
                 * @default x-end-user-token
                 */
                readonly tokenHeader?: string;
                readonly verifier: {
                    /**
                     * @default [
                     *       "RS256"
                     *     ]
                     */
                    readonly algorithms?: readonly ("RS256" | "RS384" | "RS512" | "ES256" | "ES384" | "PS256" | "HS256")[];
                    readonly audience?: string;
                    /** @default 30 */
                    readonly clockToleranceSec?: number;
                    /** @default false */
                    readonly hs256?: boolean;
                    readonly issuer?: string;
                    /**
                     * Format: uri
                     * @description Public HTTPS JWKS endpoint; production validation rejects plaintext and non-public destinations.
                     */
                    readonly jwksUri?: string;
                    /** @enum {string} */
                    readonly kind: "jwt";
                    /** @default sub */
                    readonly subjectClaim?: string;
                } | {
                    /** @default active */
                    readonly activeField?: string;
                    /** @default 60000 */
                    readonly cacheTtlMs?: number;
                    /**
                     * Format: uri
                     * @description Public HTTPS introspection endpoint; production validation rejects plaintext and non-public destinations.
                     */
                    readonly endpoint: string;
                    /** @enum {string} */
                    readonly kind: "introspection";
                    /**
                     * @default POST
                     * @enum {string}
                     */
                    readonly method?: "POST" | "GET";
                    /** @default sub */
                    readonly subjectField?: string;
                    /** @default 2000 */
                    readonly timeoutMs?: number;
                    /** @default authorization */
                    readonly tokenHeader?: string;
                    /** @default false */
                    readonly useStoredSecret?: boolean;
                };
            };
            readonly tenantId: string;
        };
        readonly TenantAuthUpdateRequest: {
            readonly policy: {
                /** @enum {string} */
                readonly mode: "trusted_caller";
            } | {
                /** @enum {string} */
                readonly mode: "end_user_token";
                /**
                 * @description Non-reserved HTTP header carrying the inbound end-user token
                 * @default x-end-user-token
                 */
                readonly tokenHeader?: string;
                readonly verifier: {
                    /**
                     * @default [
                     *       "RS256"
                     *     ]
                     */
                    readonly algorithms?: readonly ("RS256" | "RS384" | "RS512" | "ES256" | "ES384" | "PS256" | "HS256")[];
                    readonly audience?: string;
                    /** @default 30 */
                    readonly clockToleranceSec?: number;
                    /** @default false */
                    readonly hs256?: boolean;
                    readonly issuer?: string;
                    /**
                     * Format: uri
                     * @description Public HTTPS JWKS endpoint; production validation rejects plaintext and non-public destinations.
                     */
                    readonly jwksUri?: string;
                    /** @enum {string} */
                    readonly kind: "jwt";
                    /** @default sub */
                    readonly subjectClaim?: string;
                } | {
                    /** @default active */
                    readonly activeField?: string;
                    /** @default 60000 */
                    readonly cacheTtlMs?: number;
                    /**
                     * Format: uri
                     * @description Public HTTPS introspection endpoint; production validation rejects plaintext and non-public destinations.
                     */
                    readonly endpoint: string;
                    /** @enum {string} */
                    readonly kind: "introspection";
                    /**
                     * @default POST
                     * @enum {string}
                     */
                    readonly method?: "POST" | "GET";
                    /** @default sub */
                    readonly subjectField?: string;
                    /** @default 2000 */
                    readonly timeoutMs?: number;
                    /** @default authorization */
                    readonly tokenHeader?: string;
                    /** @default false */
                    readonly useStoredSecret?: boolean;
                };
            };
            readonly secret?: string;
        };
        readonly TenantErasureCreateRequest: {
            readonly tenantId: string;
        };
        readonly TenantErasureRequest: {
            readonly createdAtMs: number;
            readonly generation: number;
            readonly id: string;
            /** @enum {string} */
            readonly scope: "tenant";
            /** @enum {string} */
            readonly status: "gated";
            readonly tenantId: string;
            readonly updatedAtMs: number;
        };
        readonly ToolList: {
            readonly data: readonly {
                readonly concurrencySafe?: boolean;
                readonly description: string;
                /** @enum {string} */
                readonly kind: "builtin" | "mcp" | "dynamic" | "skill";
                readonly name: string;
                readonly needsApproval?: boolean;
                readonly parameters: {
                    readonly [key: string]: unknown;
                };
                readonly readOnly?: boolean;
            }[];
        };
        readonly ToolOutputPayload: {
            readonly content: readonly ({
                readonly text: string;
                /** @enum {string} */
                readonly type: "text";
            } | {
                readonly mimeType?: string;
                /** @enum {string} */
                readonly type: "image";
                readonly url: string;
            })[];
            readonly details?: unknown;
        };
        readonly Turn: {
            readonly completedAtMs?: number;
            readonly error?: {
                readonly code: string;
                readonly message: string;
            };
            readonly id: string;
            readonly idempotencyKey?: string;
            readonly metadata?: {
                readonly [key: string]: unknown;
            };
            readonly model?: {
                readonly model: string;
                readonly provider: string;
                /** @enum {string} */
                readonly reasoning?: "off" | "low" | "medium" | "high";
            };
            readonly partialText?: string;
            readonly seqEnd?: number;
            readonly seqStart: number;
            readonly sessionId: string;
            readonly startedAtMs: number;
            /** @enum {string} */
            readonly status: "inProgress" | "completed" | "interrupted" | "failed";
            readonly steps: number;
            /** @enum {string} */
            readonly stopReason?: "end_turn" | "max_steps" | "max_tool_calls" | "max_cost" | "max_wall_clock" | "max_output_tokens" | "interrupted" | "error";
            readonly toolCalls: number;
            readonly usage: {
                readonly cacheReadTokens: number;
                readonly cacheWriteTokens: number;
                readonly costCNY?: number;
                readonly inputTokens: number;
                readonly outputTokens: number;
                readonly reasoningTokens: number;
                readonly totalTokens: number;
            };
        };
        readonly TurnAcceptedResponse: {
            readonly steered: boolean;
            readonly turn: {
                readonly completedAtMs?: number;
                readonly error?: {
                    readonly code: string;
                    readonly message: string;
                };
                readonly id: string;
                readonly idempotencyKey?: string;
                readonly metadata?: {
                    readonly [key: string]: unknown;
                };
                readonly model?: {
                    readonly model: string;
                    readonly provider: string;
                    /** @enum {string} */
                    readonly reasoning?: "off" | "low" | "medium" | "high";
                };
                readonly partialText?: string;
                readonly seqEnd?: number;
                readonly seqStart: number;
                readonly sessionId: string;
                readonly startedAtMs: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "interrupted" | "failed";
                readonly steps: number;
                /** @enum {string} */
                readonly stopReason?: "end_turn" | "max_steps" | "max_tool_calls" | "max_cost" | "max_wall_clock" | "max_output_tokens" | "interrupted" | "error";
                readonly toolCalls: number;
                readonly usage: {
                    readonly cacheReadTokens: number;
                    readonly cacheWriteTokens: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    readonly reasoningTokens: number;
                    readonly totalTokens: number;
                };
            };
        };
        readonly TurnPage: {
            readonly data: readonly {
                readonly completedAtMs?: number;
                readonly error?: {
                    readonly code: string;
                    readonly message: string;
                };
                readonly id: string;
                readonly idempotencyKey?: string;
                readonly metadata?: {
                    readonly [key: string]: unknown;
                };
                readonly model?: {
                    readonly model: string;
                    readonly provider: string;
                    /** @enum {string} */
                    readonly reasoning?: "off" | "low" | "medium" | "high";
                };
                readonly partialText?: string;
                readonly seqEnd?: number;
                readonly seqStart: number;
                readonly sessionId: string;
                readonly startedAtMs: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "interrupted" | "failed";
                readonly steps: number;
                /** @enum {string} */
                readonly stopReason?: "end_turn" | "max_steps" | "max_tool_calls" | "max_cost" | "max_wall_clock" | "max_output_tokens" | "interrupted" | "error";
                readonly toolCalls: number;
                readonly usage: {
                    readonly cacheReadTokens: number;
                    readonly cacheWriteTokens: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    readonly reasoningTokens: number;
                    readonly totalTokens: number;
                };
            }[];
            readonly nextCursor: string | null;
        };
        readonly TurnReplayResponse: {
            readonly turn: {
                readonly completedAtMs?: number;
                readonly error?: {
                    readonly code: string;
                    readonly message: string;
                };
                readonly id: string;
                readonly idempotencyKey?: string;
                readonly metadata?: {
                    readonly [key: string]: unknown;
                };
                readonly model?: {
                    readonly model: string;
                    readonly provider: string;
                    /** @enum {string} */
                    readonly reasoning?: "off" | "low" | "medium" | "high";
                };
                readonly partialText?: string;
                readonly seqEnd?: number;
                readonly seqStart: number;
                readonly sessionId: string;
                readonly startedAtMs: number;
                /** @enum {string} */
                readonly status: "inProgress" | "completed" | "interrupted" | "failed";
                readonly steps: number;
                /** @enum {string} */
                readonly stopReason?: "end_turn" | "max_steps" | "max_tool_calls" | "max_cost" | "max_wall_clock" | "max_output_tokens" | "interrupted" | "error";
                readonly toolCalls: number;
                readonly usage: {
                    readonly cacheReadTokens: number;
                    readonly cacheWriteTokens: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    readonly reasoningTokens: number;
                    readonly totalTokens: number;
                };
            };
        };
        readonly UpsertProviderRequest: {
            /**
             * @default openai-completions
             * @enum {string}
             */
            readonly api?: "openai-completions";
            readonly apiKey?: string;
            /**
             * Format: uri
             * @description Public HTTP(S) provider endpoint. The runner resolves and rejects loopback, private, link-local, and otherwise non-public hosts before storing it.
             */
            readonly baseUrl: string;
            readonly compat?: {
                /** @enum {string} */
                readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
                readonly requiresAssistantAfterToolResult?: boolean;
                readonly requiresReasoningContentOnAssistantMessages?: boolean;
                readonly requiresToolResultName?: boolean;
                readonly supportsDeveloperRole?: boolean;
                readonly supportsJsonSchema?: boolean;
                readonly supportsReasoningEffort?: boolean;
                readonly supportsStore?: boolean;
                readonly supportsUsageInStreaming?: boolean;
                /** @enum {string} */
                readonly thinkingFormat?: "openai" | "deepseek" | "qwen" | "zai" | "openrouter";
            };
            /** @default [] */
            readonly fallback?: readonly string[];
            /** @default {} */
            readonly headers?: {
                readonly [key: string]: string;
            };
            readonly models: readonly {
                readonly compat?: {
                    /** @enum {string} */
                    readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
                    readonly requiresAssistantAfterToolResult?: boolean;
                    readonly requiresReasoningContentOnAssistantMessages?: boolean;
                    readonly requiresToolResultName?: boolean;
                    readonly supportsDeveloperRole?: boolean;
                    readonly supportsJsonSchema?: boolean;
                    readonly supportsReasoningEffort?: boolean;
                    readonly supportsStore?: boolean;
                    readonly supportsUsageInStreaming?: boolean;
                    /** @enum {string} */
                    readonly thinkingFormat?: "openai" | "deepseek" | "qwen" | "zai" | "openrouter";
                };
                /** @default 128000 */
                readonly contextWindow?: number;
                readonly id: string;
                /**
                 * @default [
                 *       "text"
                 *     ]
                 */
                readonly input?: readonly [
                    "text"
                ] | readonly [
                    "text",
                    "image"
                ] | readonly [
                    "image",
                    "text"
                ];
                /** @default 8192 */
                readonly maxOutputTokens?: number;
                readonly name?: string;
                readonly price?: {
                    /** @default 0 */
                    readonly cacheRead?: number;
                    /** @default 0 */
                    readonly cacheWrite?: number;
                    readonly input: number;
                    readonly output: number;
                };
                /** @default false */
                readonly reasoning?: boolean;
            }[];
            readonly name?: string;
            /** @default {} */
            readonly quota?: {
                readonly concurrency?: number;
                readonly rpm?: number;
            };
        };
        readonly UsageListResponse: {
            readonly data: readonly {
                readonly key: string;
                readonly steps: number;
                readonly turns: number;
                readonly usage: {
                    readonly cacheReadTokens: number;
                    readonly cacheWriteTokens: number;
                    readonly costCNY?: number;
                    readonly inputTokens: number;
                    readonly outputTokens: number;
                    readonly reasoningTokens: number;
                    readonly totalTokens: number;
                };
            }[];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type SchemaActiveLegalHoldList = components['schemas']['ActiveLegalHoldList'];
export type SchemaActiveRetentionPolicy = components['schemas']['ActiveRetentionPolicy'];
export type SchemaAgentDefinition = components['schemas']['AgentDefinition'];
export type SchemaAgentDefinitionRequest = components['schemas']['AgentDefinitionRequest'];
export type SchemaAgentPage = components['schemas']['AgentPage'];
export type SchemaApiKeyList = components['schemas']['ApiKeyList'];
export type SchemaApproval = components['schemas']['Approval'];
export type SchemaApprovalListResponse = components['schemas']['ApprovalListResponse'];
export type SchemaApprovalResponseRequest = components['schemas']['ApprovalResponseRequest'];
export type SchemaBlobUploadResponse = components['schemas']['BlobUploadResponse'];
export type SchemaCapabilities = components['schemas']['Capabilities'];
export type SchemaCompactSessionResponse = components['schemas']['CompactSessionResponse'];
export type SchemaCreateApiKeyRequest = components['schemas']['CreateApiKeyRequest'];
export type SchemaCreateApiKeyResponse = components['schemas']['CreateApiKeyResponse'];
export type SchemaCreateSessionRequest = components['schemas']['CreateSessionRequest'];
export type SchemaDataExportRequest = components['schemas']['DataExportRequest'];
export type SchemaDynamicToolResultRequest = components['schemas']['DynamicToolResultRequest'];
export type SchemaErasureRequest = components['schemas']['ErasureRequest'];
export type SchemaErrorBody = components['schemas']['ErrorBody'];
export type SchemaEvent = components['schemas']['Event'];
export type SchemaExcludableEventType = components['schemas']['ExcludableEventType'];
export type SchemaItemListResponse = components['schemas']['ItemListResponse'];
export type SchemaLegalHold = components['schemas']['LegalHold'];
export type SchemaLegalHoldReleaseRequest = components['schemas']['LegalHoldReleaseRequest'];
export type SchemaLegalHoldSetRequest = components['schemas']['LegalHoldSetRequest'];
export type SchemaModelList = components['schemas']['ModelList'];
export type SchemaOkResponse = components['schemas']['OkResponse'];
export type SchemaOpenApiDocument = components['schemas']['OpenApiDocument'];
export type SchemaProviderConfig = components['schemas']['ProviderConfig'];
export type SchemaProviderList = components['schemas']['ProviderList'];
export type SchemaResumeSessionResponse = components['schemas']['ResumeSessionResponse'];
export type SchemaRetentionPolicy = components['schemas']['RetentionPolicy'];
export type SchemaRetentionPolicyActivateRequest = components['schemas']['RetentionPolicyActivateRequest'];
export type SchemaRetentionPolicyPutRequest = components['schemas']['RetentionPolicyPutRequest'];
export type SchemaSession = components['schemas']['Session'];
export type SchemaSessionPage = components['schemas']['SessionPage'];
export type SchemaStartTurnRequest = components['schemas']['StartTurnRequest'];
export type SchemaSteerRequest = components['schemas']['SteerRequest'];
export type SchemaTenantAuthState = components['schemas']['TenantAuthState'];
export type SchemaTenantAuthUpdateRequest = components['schemas']['TenantAuthUpdateRequest'];
export type SchemaTenantErasureCreateRequest = components['schemas']['TenantErasureCreateRequest'];
export type SchemaTenantErasureRequest = components['schemas']['TenantErasureRequest'];
export type SchemaToolList = components['schemas']['ToolList'];
export type SchemaToolOutputPayload = components['schemas']['ToolOutputPayload'];
export type SchemaTurn = components['schemas']['Turn'];
export type SchemaTurnAcceptedResponse = components['schemas']['TurnAcceptedResponse'];
export type SchemaTurnPage = components['schemas']['TurnPage'];
export type SchemaTurnReplayResponse = components['schemas']['TurnReplayResponse'];
export type SchemaUpsertProviderRequest = components['schemas']['UpsertProviderRequest'];
export type SchemaUsageListResponse = components['schemas']['UsageListResponse'];
export type $defs = Record<string, never>;
export interface operations {
    readonly getHealth: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The process is alive. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "text/plain": string;
                };
            };
        };
    };
    readonly getOpenApiDocument: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description OpenAPI 3.1 document for this service. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["OpenApiDocument"];
                };
            };
        };
    };
    readonly getReadiness: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The service is ready. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "text/plain": string;
                };
            };
            /** @description The service is not ready or is draining. */
            readonly 503: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "text/plain": string;
                };
            };
        };
    };
    readonly listAgents: {
        readonly parameters: {
            readonly query?: {
                readonly cursor?: string;
                readonly limit?: number;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description A page of agent definitions. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AgentPage"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly createAgent: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Agent definition. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["AgentDefinitionRequest"];
            };
        };
        readonly responses: {
            /** @description Created agent definition. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AgentDefinition"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getAgent: {
        readonly parameters: {
            readonly query?: {
                readonly version?: number;
            };
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Agent definition. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AgentDefinition"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly updateAgent: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        /** @description Replacement agent definition. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["AgentDefinitionRequest"];
            };
        };
        readonly responses: {
            /** @description New agent definition version. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AgentDefinition"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getCapabilities: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Current runner or router capabilities. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Capabilities"];
                };
            };
            /** @description Error response. */
            readonly 503: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly requestUserErasure: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "idempotency-key": string;
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Existing or newly accepted user erasure request. */
            readonly 202: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErasureRequest"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getUserErasureRequest: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly requestId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Erasure request status. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErasureRequest"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly requestUserDataExport: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "idempotency-key": string;
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Existing or newly accepted user data export request. */
            readonly 202: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["DataExportRequest"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getUserDataExportRequest: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly requestId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Data export request status. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["DataExportRequest"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly downloadUserDataExport: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly requestId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Complete NDJSON export artifact. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description SHA-256 digest of the complete artifact using HTTP structured-field syntax. */
                    readonly "Content-Digest"?: string;
                    /** @description Attachment disposition with a server-generated ASCII filename. */
                    readonly "Content-Disposition"?: string;
                    /** @description Artifact transfer length when known; proxies may omit it and use chunked transfer. */
                    readonly "Content-Length"?: number;
                    /** @description Complete artifact size in bytes, independent of transfer framing. */
                    readonly "X-Artifact-Size"?: number;
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/vnd.agent-service.user-export+ndjson": string;
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listActiveLegalHolds: {
        readonly parameters: {
            readonly query: {
                readonly subjectId: string;
                readonly subjectKind: "tenant" | "user";
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Active holds and fail-closed projection control. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ActiveLegalHoldList"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly setLegalHold: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Bounded hold identity, scope and reason. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["LegalHoldSetRequest"];
            };
        };
        readonly responses: {
            /** @description Existing or newly set legal hold. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["LegalHold"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getLegalHold: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly holdId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Legal hold. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["LegalHold"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly releaseLegalHold: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly holdId: string;
            };
            readonly cookie?: never;
        };
        /** @description Expected subject hold generation and bounded release reason. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["LegalHoldReleaseRequest"];
            };
        };
        readonly responses: {
            /** @description Released legal hold. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["LegalHold"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listModels: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Visible model catalog. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ModelList"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listProviders: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Visible provider configurations. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ProviderList"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly upsertProvider: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        /** @description Provider configuration; apiKey is write-only. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["UpsertProviderRequest"];
            };
        };
        readonly responses: {
            /** @description Stored provider configuration with secrets redacted. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ProviderConfig"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly deleteProvider: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Provider deleted. */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getRetentionPolicy: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly policyVersion: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Immutable policy version. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RetentionPolicy"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly putRetentionPolicy: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly policyVersion: string;
            };
            readonly cookie?: never;
        };
        /** @description Complete version-1 retention policy document. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["RetentionPolicyPutRequest"];
            };
        };
        readonly responses: {
            /** @description Existing or newly registered immutable policy version. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RetentionPolicy"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly activateRetentionPolicy: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly policyVersion: string;
            };
            readonly cookie?: never;
        };
        /** @description Expected policy-control generation. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["RetentionPolicyActivateRequest"];
            };
        };
        readonly responses: {
            /** @description Active policy and its monotonic control. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ActiveRetentionPolicy"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getActiveRetentionPolicy: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Active policy and its monotonic control. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ActiveRetentionPolicy"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listSessions: {
        readonly parameters: {
            readonly query?: {
                readonly cursor?: string;
                readonly includeArchived?: boolean;
                readonly limit?: number;
                readonly userId?: string;
            };
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description A page of sessions. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["SessionPage"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly createSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Session creation request. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["CreateSessionRequest"];
            };
        };
        readonly responses: {
            /** @description Created session. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Session"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Session state. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Session"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly deleteSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Session tombstoned. */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listApprovals: {
        readonly parameters: {
            readonly query?: {
                readonly pending?: "true" | "false";
            };
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Session approvals. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ApprovalListResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly resolveApproval: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly approvalId: string;
                readonly id: string;
            };
            readonly cookie?: never;
        };
        /** @description Approval decision. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["ApprovalResponseRequest"];
            };
        };
        readonly responses: {
            /** @description Resolved approval. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Approval"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly archiveSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Archived session. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Session"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly uploadSessionBlob: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        /** @description Raw input-image bytes. Send the image media type in Content-Type. */
        readonly requestBody: {
            readonly content: {
                readonly "image/gif": string;
                readonly "image/jpeg": string;
                readonly "image/png": string;
                readonly "image/webp": string;
            };
        };
        readonly responses: {
            /** @description Staged input image. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["BlobUploadResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getSessionBlob: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly blobId: string;
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Attached blob bytes; Content-Type is the recorded media type. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "image/gif": string;
                    readonly "image/jpeg": string;
                    readonly "image/png": string;
                    readonly "image/webp": string;
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly compactSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Compaction result. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["CompactSessionResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly subscribeEvents: {
        readonly parameters: {
            readonly query?: {
                readonly after?: number | null;
                /** @description Comma-separated event types. Allowed values: item/reasoning/delta, item/toolCall/argsDelta, item/agentMessage/delta, usage/updated, heartbeat. */
                readonly exclude?: string;
            };
            readonly header?: {
                readonly "last-event-id"?: number | null;
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Replay followed by live Server-Sent Events. */
            readonly 200: {
                headers: {
                    /** @description The stream is not cached. */
                    readonly "Cache-Control"?: string;
                    /** @description Disables reverse-proxy buffering. */
                    readonly "X-Accel-Buffering"?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "text/event-stream": string;
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listItems: {
        readonly parameters: {
            readonly query?: {
                readonly afterSeq?: number | null;
                readonly limit?: number;
                readonly turnId?: string;
            };
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Session items. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ItemListResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getItemOutput: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
                readonly itemId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Full offloaded tool output. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ToolOutputPayload"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly resumeSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Session snapshot, recent turns and replay cursor. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ResumeSessionResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listTurns: {
        readonly parameters: {
            readonly query?: {
                readonly cursor?: string;
                readonly limit?: number;
                readonly sortDirection?: "asc" | "desc";
            };
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description A page of turns. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["TurnPage"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly startTurn: {
        readonly parameters: {
            readonly query?: {
                /** @description Comma-separated event types. Allowed values: item/reasoning/delta, item/toolCall/argsDelta, item/agentMessage/delta, usage/updated, heartbeat. */
                readonly exclude?: string;
            };
            readonly header?: {
                readonly "idempotency-key"?: string;
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        /** @description Turn input and execution options. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["StartTurnRequest"];
            };
        };
        readonly responses: {
            /** @description SSE event stream, or a completed idempotency replay as JSON. */
            readonly 200: {
                headers: {
                    /** @description SSE streams are not cached. */
                    readonly "Cache-Control"?: string;
                    /** @description True only when the JSON response is a completed idempotency replay. */
                    readonly "Idempotency-Replayed"?: boolean;
                    /** @description Disables reverse-proxy buffering for SSE. */
                    readonly "X-Accel-Buffering"?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["TurnReplayResponse"];
                    readonly "text/event-stream": string;
                };
            };
            /** @description Turn accepted for asynchronous execution. */
            readonly 202: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["TurnAcceptedResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getTurn: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
                readonly turnId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Turn state. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Turn"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly interruptTurn: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
                readonly turnId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Interrupted or already-terminal turn. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Turn"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly steerTurn: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
                readonly turnId: string;
            };
            readonly cookie?: never;
        };
        /** @description Steer input and optional active-turn precondition. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["SteerRequest"];
            };
        };
        readonly responses: {
            /** @description Steer accepted. */
            readonly 202: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["OkResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly submitDynamicToolResult: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
                readonly turnId: string;
            };
            readonly cookie?: never;
        };
        /** @description Dynamic tool result. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["DynamicToolResultRequest"];
            };
        };
        readonly responses: {
            /** @description Tool result accepted. */
            readonly 202: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["OkResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly unarchiveSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Unarchived session. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Session"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly requestTenantErasure: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "idempotency-key": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Target tenant. The platform credential is intentionally outside that tenant's credential plane. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["TenantErasureCreateRequest"];
            };
        };
        readonly responses: {
            /** @description Existing or newly accepted tenant erasure request. */
            readonly 202: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["TenantErasureRequest"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getTenantErasureRequest: {
        readonly parameters: {
            readonly query: {
                readonly tenantId: string;
            };
            readonly header?: never;
            readonly path: {
                readonly requestId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Tenant erasure request status. */
            readonly 200: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["TenantErasureRequest"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    /** @description Prevents storage of this sensitive lifecycle response. */
                    readonly "Cache-Control"?: "no-store";
                    /** @description Prevents content-type sniffing. */
                    readonly "X-Content-Type-Options"?: "nosniff";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listApiKeys: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Tenant API key records. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ApiKeyList"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly createApiKey: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Key label and scopes. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["CreateApiKeyRequest"];
            };
        };
        readonly responses: {
            /** @description Created API key and one-time secret. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["CreateApiKeyResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly revokeApiKey: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly keyId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description API key revoked. */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly getTenantAuth: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Tenant authentication state; secrets are never returned. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["TenantAuthState"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly updateTenantAuth: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Authentication policy and optional write-only secret. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["TenantAuthUpdateRequest"];
            };
        };
        readonly responses: {
            /** @description Updated tenant authentication state. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["TenantAuthState"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly listTools: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Visible tool catalog. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ToolList"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    readonly queryUsage: {
        readonly parameters: {
            readonly query?: {
                readonly from?: number | null;
                readonly groupBy?: "total" | "user" | "session" | "model" | "day";
                readonly limit?: number;
                readonly sessionId?: string;
                readonly to?: number | null;
                readonly userId?: string;
            };
            readonly header?: {
                /** @description Default end-user token header. A tenant may configure a different header name in its auth policy. */
                readonly "x-end-user-token"?: string;
                /** @description User asserted by a trusted tenant backend. */
                readonly "x-user-id"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Usage rollups. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["UsageListResponse"];
                };
            };
            /** @description Error response. */
            readonly default: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
}
