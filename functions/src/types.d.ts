declare module "firebase-admin/app" {
  export const getApps: () => any[];
  export const initializeApp: () => any;
}

declare module "firebase-admin/firestore" {
  export type DocumentReference = {
    path: string;
  };
  export type CollectionReference = {
    doc: (id?: string) => DocumentReference;
    collection: (path: string) => CollectionReference;
  };
  export const FieldValue: {
    serverTimestamp: () => any;
  };
  export const getFirestore: () => any;
}

declare module "firebase-admin/messaging" {
  export interface SendResponse {
    success: boolean;
    error?: { code?: string; message?: string };
  }
  export interface MessagingBatchResponse {
    successCount: number;
    failureCount: number;
    responses: SendResponse[];
  }
  export type MulticastMessage = {
    tokens: string[];
    notification?: {
      title?: string;
      body?: string;
    };
    data?: Record<string, string>;
  };
  export type MessagingOptions = Record<string, unknown>;
  export const getMessaging: () => {
    sendEachForMulticast: (
      message: MulticastMessage,
      options?: MessagingOptions
    ) => Promise<MessagingBatchResponse>;
  };
}

declare module "firebase-functions/v2" {
  export const setGlobalOptions: (options: any) => void;
}

declare module "firebase-functions/v2/firestore" {
  export interface FirestoreEvent<T = any, P = any> {
    data?: T;
    params: P;
  }
  export const onDocumentCreated: (
    path: string,
    handler: (event: FirestoreEvent) => any
  ) => any;
}

declare module "firebase-functions/v2/scheduler" {
  export const onSchedule: (options: any, handler: (event: any) => any) => any;
}
