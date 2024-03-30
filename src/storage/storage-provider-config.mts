export interface StorageProviderConfig {
    /**
     * Connection string that specifies the database and the credentials used to connect to it
     * The database and the credentials must already exists
     */
    connectionString: string;

    /**
     * NOT USED
     * Connection string that specifies admin credentials
     * Used only if the database and credentials are not created and must be created by the application
     * Then use the databse name and credentials in the "connectionString"
     * This is needed only on the first application run and should be removed after the database and credentials are created
     */
    adminConnectionString?: string;

    /**
     * The path to the directory containing files for database migrations
     */
    databaseMigrationsPath?: string;
}
