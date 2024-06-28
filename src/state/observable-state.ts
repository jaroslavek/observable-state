import { Injectable, OnDestroy } from '@angular/core';
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  filter,
  map,
  Observable,
  pipe,
  ReplaySubject,
  startWith,
  Subject,
  switchMap,
  takeUntil,
} from 'rxjs';

const filterAndCastToT = <T>() =>
  pipe(
    filter((v: T | null) => v !== null),
    map((v) => v as T)
  );

// we need this dirty fix because of an issue with BehaviorSubject
// queuescheduler didn't cut it
export class StateSubject<T> extends BehaviorSubject<T> {
  public readonly syncState = this.asObservable().pipe(
    map(() => this.value)
  ) as Observable<T>;
}

@Injectable()
export class ObservableState<T extends Record<string, unknown>>
  implements OnDestroy
{
  private readonly notInitializedError =
    'Observable state is not initialized yet, call the initialize() method';
  private readonly destroy$$ = new Subject<void>();
  private readonly state$$ = new StateSubject<T | null>(null);
  private readonly triggers: { [P in keyof T]?: ReplaySubject<void> } = {};

  /**
   * Return the entire state as an observable
   * Only use this if you want to be notified on every update. For better optimization
   * use the onlySelectWhen() method
   * where we can pass keys on when to notify.
   */
  public readonly state$ = this.state$$.syncState.pipe(
    filterAndCastToT<T>(),
    distinctUntilChanged((previous: T, current: T) =>
      Object.keys(current).every(
        (key: string) => current[key as keyof T] === previous[key as keyof T]
      )
    ),
    takeUntil(this.destroy$$)
  );

  /**
   * Get a snapshot of the current state. This method is needed when we want to fetch the
   * state in functions. We don't have to use withLatestFrom if we want to keep it simple.
   */
  public get snapshot(): T {
    if (!this.state$$.value) {
      throw new Error(this.notInitializedError);
    }
    return this.state$$.value as T;
  }

  /**
   * Observable state doesn't work without initializing it first. Our state always needs
   * an initial state. You can pass the @InputState() as an optional parameter.
   * Passing that @InputState() will automatically feed the state with the correct values
   * @param state
   * @param inputState$
   */
  public initialize(state: T, inputState$?: Observable<Partial<T>>): void {
    this.state$$.next(state); // pass initial state
    // Feed the state when the input state gets a new value
    inputState$
      ?.pipe(takeUntil(this.destroy$$))
      .subscribe((res: Partial<T>) => this.patch(res));
  }

  /**
   * This method is used to connect multiple observables to a partial of the state
   * pass in an object with keys that belong to the state with their observable
   * @param object
   */
public connect(object: Partial<{ [P in keyof T]: Observable<T[P]> }>): void {
  Object.keys(object).forEach(key => {
    const typedKey = key as keyof T;  // Explicitně typujeme klíč

    if (!this.triggers[typedKey]) {
      this.triggers[typedKey] = new ReplaySubject<void>(1);
      this.triggers[typedKey]!.next();  // Emit initial value
    }

    combineLatest([this.triggers[typedKey]!, object[typedKey]!])
      .pipe(
        switchMap(([_, value]) => object[typedKey]!.pipe(startWith(value))),
        takeUntil(this.destroy$$)
      )
      .subscribe(value => this.patch({ [typedKey]: value } as Partial<T>));
  });
}

  /**
   * Returns the entire state when one of the properties matching the passed keys changes
   * @param keys
   */
  public onlySelectWhen(keys: (keyof T)[]): Observable<T> {
    return this.state$$.syncState.pipe(
      filterAndCastToT<T>(),
      distinctUntilChanged((previous: T, current: T) =>
        keys.every(
          (key: keyof T) => current[key as keyof T] === previous[key as keyof T]
        )
      ),
      takeUntil(this.destroy$$)
    );
  }

  /**
   * Returns an observable of a specifically selected piece of state by a key
   * @param key
   */
  public select<P extends keyof T>(key: P): Observable<T[P]> {
    return this.onlySelectWhen([key]).pipe(map((state) => state[key]));
  }

  /**
   * Patch a partial of the state. It will loop over all the properties of the passed
   * object and only next the state once.
   * @param object
   */
  public patch(object: Partial<T>): void {
    if (!this.state$$.value) {
      throw new Error(this.notInitializedError);
    }
    let newState: T = { ...this.state$$.value };
    Object.keys(object).forEach((key: string) => {
      newState = { ...newState, [key]: object[key as keyof T] };
    });
    this.state$$.next(newState);
  }

  /**
   * Pick pieces of the state and create an object that has Observables for every key that is passed
   * @param keys
   */
  public pick<P>(
    keys: (keyof T)[]
  ): Partial<{ [P in keyof T]: Observable<T[P]> }> {
    const returnObj: Partial<{ [P in keyof T]: Observable<T[P]> }> = {};
    keys.forEach((key: keyof T) => {
      returnObj[key] = this.onlySelectWhen([key]).pipe(
        map((state: T) => state[key])
      );
    });
    return returnObj;
  }

  /**
   * Retriggers the producer function of the Observable that is connected to this key
   * This only works in combination with the `connect()` method.
   * @param key
   */
  public trigger(key: keyof T): void {
    if (!this.triggers[key]) {
      throw new Error(
        'There is no trigger registered for this key! You need to connect an observable. ' +
          'Please use connect to register the triggers'
      );
    }
    this.triggers[key]!.next();
  }

  public ngOnDestroy(): void {
    this.destroy$$.next();
    this.destroy$$.complete();
  }
}
