export function createPropertyReadCounter() {
  let propertyReads = 0;
  return {
    track<T extends object>(value: T): T {
      return new Proxy(value, {
        get(target, property, receiver) {
          propertyReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    },
    count() {
      return propertyReads;
    },
  };
}
