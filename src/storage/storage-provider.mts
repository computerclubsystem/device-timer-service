import { DeviceStateLog } from './entties/device-state-log.mjs';
import { Device } from './entties/device.mjs';
import { StorageProviderConfig } from './storage-provider-config.mjs';
import { StorageProviderInitResult } from './storage-provider-init-result.mjs';

export interface StorageProvider {
    init(config: StorageProviderConfig): Promise<StorageProviderInitResult>;
    addDeviceStateLog(entity: DeviceStateLog): Promise<void>
    getDeviceByCertificateThumbprint(certificateThumbprint: string): Promise<Device | undefined>
    saveDevice(device: Device): Promise<Device | undefined>
}