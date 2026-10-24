// Value types shared by every service and every mode. Drivers convert them to and from the
// native types of the SDK they wrap (firebase/firestore, firebase-admin, the IceBase server).

/** Same shape and methods as Firebase's Timestamp. */
export class Timestamp {
  constructor(readonly seconds: number, readonly nanoseconds: number) {
    if (!Number.isInteger(seconds) || !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds >= 1e9) {
      throw new RangeError(`Timestamp(${seconds}, ${nanoseconds}): seconds must be an integer and nanoseconds in [0, 1e9)`);
    }
  }
  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  static fromDate(d: Date): Timestamp {
    return Timestamp.fromMillis(d.getTime());
  }
  static fromMillis(ms: number): Timestamp {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.round((ms - seconds * 1000) * 1e6));
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  toMillis(): number {
    return this.seconds * 1000 + this.nanoseconds / 1e6;
  }
  isEqual(other: Timestamp): boolean {
    return other instanceof Timestamp && other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
  valueOf(): string {
    // Sortable, like Firebase's: lets `<` and `>` compare timestamps.
    return `${String(this.seconds + 62135596800).padStart(12, '0')}.${String(this.nanoseconds).padStart(9, '0')}`;
  }
  toJSON(): { seconds: number; nanoseconds: number; type: 'timestamp' } {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds, type: 'timestamp' };
  }
  toString(): string {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
}

/** Same as Firebase's GeoPoint. */
export class GeoPoint {
  constructor(readonly latitude: number, readonly longitude: number) {
    if (!(latitude >= -90 && latitude <= 90)) throw new RangeError(`GeoPoint latitude ${latitude} is outside [-90, 90]`);
    if (!(longitude >= -180 && longitude <= 180)) throw new RangeError(`GeoPoint longitude ${longitude} is outside [-180, 180]`);
  }
  isEqual(other: GeoPoint): boolean {
    return other instanceof GeoPoint && other.latitude === this.latitude && other.longitude === this.longitude;
  }
  toJSON(): { latitude: number; longitude: number } {
    return { latitude: this.latitude, longitude: this.longitude };
  }
}

/** Write-time sentinels (serverTimestamp, increment, …). One class so drivers can switch on `op`.
 * 'serverTime' is the Realtime Database's serverTimestamp(): milliseconds, a number. */
export class FieldValue {
  /** @internal */
  constructor(
    readonly op: 'serverTimestamp' | 'serverTime' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete',
    readonly operand?: unknown,
  ) {}
  isEqual(other: FieldValue): boolean {
    return other instanceof FieldValue && other.op === this.op && JSON.stringify(other.operand) === JSON.stringify(this.operand);
  }
}

export const isFieldValue = (v: unknown): v is FieldValue => v instanceof FieldValue;

/** A plain object (not a class instance such as Timestamp, a reference or a sentinel). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
