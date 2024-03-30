import { URL } from 'node:url';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pg, { QueryConfig } from 'pg';

import { StorageProviderConfig } from 'src/storage/storage-provider-config.mjs';
import { StorageProvider } from 'src/storage/storage-provider.mjs';
import { StorageProviderInitResult } from 'src/storage/storage-provider-init-result.mjs';
import { Logger } from '../logger.mjs';
import { Metadata } from 'src/storage/entties/metadata.mjs';
import { DeviceStateLog } from 'src/storage/entties/device-state-log.mjs';
import { Device } from 'src/storage/entties/device.mjs';

export class PostgreStorageProvider implements StorageProvider {
    private state: PostgreStorageProviderState;
    private logger: Logger;
    private readonly className = (this as any).constructor.name;

    constructor() {
        this.logger = new Logger();
        this.logger.setPrefix(this.className);
        this.state = {} as PostgreStorageProviderState;
    }

    async init(config: StorageProviderConfig): Promise<StorageProviderInitResult> {
        const result: StorageProviderInitResult = { success: false };
        const connectionStringLength = config.connectionString?.length || 0;
        if (connectionStringLength === 0) {
            this.logger.error(`The connection string is empty. It must be in format postgresql://<host>:<port>/<database-name>?user=<username>&password=<password>`);
            result.success = false;
            return result;
        }
        this.state.config = config;
        this.state.pool = this.createConnectionPool();
        const migrateResult = await this.migrateDatabase();
        result.success = migrateResult.success;
        return result;
    }

    async saveDevice(device: Device): Promise<Device | undefined> {
        const query = `
        INSERT INTO device
        (
            certificate_thumbprint, certificate_subject, certificate_issuer, created_at, approved, enabled, device_group_id
        )
        VALUES
        (
            $1, $2, $3, $4, $5, $6, $7
        )
        RETURNING id, certificate_thumbprint, certificate_subject, certificate_issuer, created_at, approved, enabled, device_group_id
        `;
        const params: any[] = [
            device.certificate_thumbprint, device.certificate_subject, device.certificate_issuer,
            device.created_at, device.approved, device.enabled, device.device_group_id,
        ];
        const res = await this.execQuery(query, params);
        return res.rows[0];
    }

    async getDeviceByCertificateThumbprint(certificateThumbprint: string): Promise<Device | undefined> {
        const query = `
        SELECT id, certificate_thumbprint, certificate_subject, created_at, approved, enabled, device_group_id
        FROM device
        WHERE certificate_thumbprint = $1
        LIMIT 1
        `;
        const params: any[] = [
            certificateThumbprint,
        ];
        const res = await this.execQuery(query, params);
        return res.rows[0];
    }

    async addDeviceStateLog(entity: DeviceStateLog): Promise<void> {
        const query = `
        INSERT INTO device_state_log
        (
            device_id, device_time, cpu_temperature, cpu_usage, storage_free_space,
            input1_value, input2_value, input3_value,
            output1_value, output2_value, output3_value,
            received_at
        )
        VALUES ( 
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10, $11,
            $12
        )
        `;
        // 3, '2024-03-24T01:02:03', 62.50, 8.13, 8427746352,
        // true, false, false,
        // false, true, true,
        // '2024-03-24T01:02:05'
        const now = Date.now();
        const device_id = 3;
        const device_time = new Date(now - 2000).toISOString();
        const cpu_temperature = 55 + Math.random() * 15;
        const cpu_usage = 5 + Math.random() * 4;
        const storage_free_space = 12_876_345_234 + Math.floor(Math.random() * 123_456_789);
        const input1_value = Math.random() < 0.5;
        const input2_value = Math.random() < 0.5;
        const input3_value = Math.random() < 0.5;
        const output1_value = Math.random() < 0.5;
        const output2_value = Math.random() < 0.5;
        const output3_value = Math.random() < 0.5;
        const received_at = new Date(now).toISOString();
        const params: any[] = [
            device_id, device_time, cpu_temperature, cpu_usage, storage_free_space,
            input1_value, input2_value, input3_value,
            output1_value, output2_value, output3_value,
            received_at,
        ];
        const res = await this.execQuery(query, params);
    }

    private async execQuery(query: string, params?: any[]): Promise<pg.QueryResult<any>> {
        let client: pg.PoolClient | null = null;
        let res: pg.QueryResult<any>;
        try {
            client = await this.getPoolClient();
            res = await client.query(query, params);
        } finally {
            client?.release();
        }
        return res;
    }

    private async migrateDatabase(): Promise<MigrateDatabaseResult> {
        this.logger.log(`Using connection string with length ${this.state.config.connectionString.length}`);

        const result: MigrateDatabaseResult = { success: false };

        // TODO: Check if this.state.config.adminConnectionString
        //       If provided, try to use it to check for existence of database and credentials
        //       specified in this.state.config.connectionString
        //       If the database or credentials do not exist - create them and make the credentials owner to the databs
        if (this.state.config.adminConnectionString) {
            try {
                await this.createDatabaseAndCredentials();
            } catch (err) {
                this.logger.error(`Cannot create the database and credentials`, err);
                result.success = false;
                return result;
            }
        }

        let migrateClient: pg.PoolClient | undefined;
        try {
            migrateClient = await this.getPoolClient();
            await migrateClient.query('BEGIN');
            let databaseVersion = 0;
            try {
                const existenceResult = await migrateClient.query(`
                    SELECT EXISTS (
                        SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='db_metadata'
                    );`
                );
                if (existenceResult.rowCount === 1 && existenceResult.rows[0].exists) {
                    const versionResult = await migrateClient.query(`SELECT value FROM db_metadata WHERE name=$1::text`, ['database-version']);
                    if (versionResult.rowCount === 1) {
                        databaseVersion = parseInt((versionResult.rows[0] as Metadata).value!);
                    }
                } else {
                    databaseVersion = 0;
                }
            } catch (err) {
                this.logger.log('Cannot get database version', err);
                result.success = false;
                return result;
            }

            this.logger.log('Database version', databaseVersion);
            const migrationsScriptsPath = path.resolve(this.state.config.databaseMigrationsPath || './database-migrations');
            const dirEntries = await fs.readdir(migrationsScriptsPath, { withFileTypes: true });
            // Sort as file names are numbers
            const sortedDirEntries = [...dirEntries].sort((a, b) => parseInt(path.parse(a.name).name) - parseInt(path.parse(b.name).name));
            // TODO: Check if all the files are in sequence without gaps and that the database version is less that or equal to the last script
            if (databaseVersion !== sortedDirEntries.length) {
                this.logger.log('Will migrate the database version from', databaseVersion, 'to', sortedDirEntries.length);
                for (let i = databaseVersion + 1; i <= sortedDirEntries.length; i++) {
                    const dirEntry = sortedDirEntries[i - 1];
                    const scriptFilePath = path.join(dirEntry.path, dirEntry.name);
                    const scriptContent = (await fs.readFile(scriptFilePath)).toString();
                    this.logger.log('Executing database migration script', scriptFilePath, scriptContent);
                    const queryResult = await migrateClient.query(scriptContent);
                    this.logger.log('Script execution completed');
                    // TODO: Show the results of the query - it could be array or something ele
                    if (Array.isArray(queryResult)) {
                    }
                }
            } else {
                this.logger.log('Database version is up to date');
            }
            await migrateClient.query('COMMIT');
        } catch (err) {
            this.logger.error(`Cannot update the database`, err);
            await migrateClient?.query('ROLLBACK');
            result.success = false;
            return result;
        } finally {
            migrateClient?.release();
        }

        result.success = true;
        return result;
    }

    private async createDatabaseAndCredentials(): Promise<void> {
        // let createDatabaseClient: pg.Client | undefined;
        // let dbName: string | null = null;
        // try {
        //     const url = new URL(this.state.config.connectionString);
        //     dbName = url.pathname.replaceAll('/', '') || url.searchParams.get('dbname');
        //     this.logger.log(`Using database '${dbName}'`);
        //     if (!dbName) {
        //         result.success = false;
        //         this.logger.error(`The connection string dbname is missing or empty`);
        //         return result;
        //     }
        //     // TODO: Connection string that contains non-existent database
        //     //       cannot be used to create the database
        //     //       because it throws exception with code 3D000 "database ... does not exist" when connected.
        //     //       For now the database must be already created and the specified user must have access to it
        //     //       or we must use second connection string specifying no database and a user that can create databases
        //     //       and assign users to them. This second connection string will be used to create the database and the user
        //     //       and when ready, the application will switch to the first connection string. For security reasons,
        //     //       this would require removing the second (admin) connection string environment variable after the database is created
        //     createDatabaseClient = new pg.Client({ connectionString: this.state.config.adminConnectionString });
        //     const res = await createDatabaseClient.query(`SELECT FROM pg_database WHERE datname=$1::text`, [dbName]);
        //     if (res.rowCount === 0) {
        //         this.logger.log(`The database does not exist. Will create it`);
        //         const createDatabaseRes = await createDatabaseClient.query(`CREATE DATABASE "${dbName}"`);
        //         this.logger.log(`The database was created`);
        //     }
        // } catch (err) {
        //     this.logger.error(`Cannot create the database`, err);
        //     result.success = false;
        //     return result;
        // } finally {
        //     createDatabaseClient?.release();
        // }
    }

    private createConnectionPool(): pg.Pool {
        return new pg.Pool({ connectionString: this.state.config.connectionString } as pg.PoolConfig);
        // return new pg.Pool({ 
        //     user: 'device-timer-service',
        //     password: 'pass',
        //     database: 'device_timer',
        //  } as pg.PoolConfig);
    }

    private async getPoolClient(): Promise<pg.PoolClient> {
        const client = await this.state.pool.connect();
        return client;
    }
}

interface PostgreStorageProviderState {
    config: StorageProviderConfig;
    pool: pg.Pool;
}

interface MigrateDatabaseResult {
    success: boolean;
}
