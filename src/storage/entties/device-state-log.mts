export interface DeviceStateLog {
    id?: number;
    device_id: number;
    device_time?: string;
    cpu_temperature?: number;
    cpu_usage?: number;
    storage_free_space?: number;
    input1_value?: boolean;
    input2_value?: boolean;
    input3_value?: boolean;
    output1_value?: boolean;
    output2_value?: boolean;
    output3_value?: boolean;
    remaining_seconds?: number;
    received_at: string;
}
