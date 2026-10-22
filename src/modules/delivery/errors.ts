/** A delivery request that can't be done, with the HTTP status and code the API answers with. */
export class DeliveryError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
