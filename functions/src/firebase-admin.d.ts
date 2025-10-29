declare module "firebase-admin" {
  interface AppNamespace {
    apps: unknown[];
    initializeApp: (...args: any[]) => unknown;
  }
  const admin: AppNamespace;
  export = admin;
}
