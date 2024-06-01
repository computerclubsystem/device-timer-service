export const envVars = {
    /**
     * The path to the operator web application static files to serve. Default is "./web-app"
     */
    CCS3_DEVICE_TIMER_SERVICE_STATIC_FILES_PATH: 'CCS3_DEVICE_TIMER_SERVICE_STATIC_FILES_PATH',
    /**
     * Whether to serve the application static files. Value of "true" or "1" will skip serving the static files. Default is empty value meaning the app will serve the static files
     */
    CCS3_DEVICE_TIMER_SERVICE_NO_STATIC_FILES_SERVING: 'CCS3_DEVICE_TIMER_SERVICE_NO_STATIC_FILES_SERVING',
    /**
     * Reserved for future use. Database connection with admin credentials. Can be used in the future to create the application database and its user automatically
     */
    CCS3_DEVICE_TIMER_SERVICE_STORAGE_ADMIN_CONNECTION_STRING: 'CCS3_DEVICE_TIMER_SERVICE_STORAGE_ADMIN_CONNECTION_STRING',
    /**
     * Database connection string. Must point to the application database and contain its owner credentials
     */
    CCS3_DEVICE_TIMER_SERVICE_STORAGE_CONNECTION_STRING: 'CCS3_DEVICE_TIMER_SERVICE_STORAGE_CONNECTION_STRING',
    /**
     * The path to the directory that contains database migration scripts used to update the database schema if needed.
     */
    CCS3_DEVICE_TIMER_SERVICE_STORAGE_PROVIDER_DATABASE_MIGRATION_SCRIPTS_DIRECTORY: 'CCS3_DEVICE_TIMER_SERVICE_STORAGE_PROVIDER_DATABASE_MIGRATION_SCRIPTS_DIRECTORY',
};
