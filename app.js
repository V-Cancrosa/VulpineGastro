const LOCATIONS = [
  { id: 'location-1', name: 'Punkt 1' },
  { id: 'location-2', name: 'Punkt 2' },
  { id: 'location-3', name: 'Punkt 3' },
  { id: 'location-4', name: 'Punkt 4' },
];
const databasePromise = openDatabase();

let activeView = 'point';
let currentCard = null;
let currentOutbox = null;
let managerCards = [];
let payrollApproval = null;
let managerPayouts = [];
let selectedManagerCardId = '';
let syncInFlight = new Set();
let refreshTimer = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vulpine-pizza-local', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('cards')) database.createObjectStore('cards', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('outbox')) database.createObjectStore('outbox', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGet(storeName, key) {
  return databasePromise.then((database) => new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function dbGetAll(storeName) {
  return databasePromise.then((database) => new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function dbDelete(storeName, key) {
  return databasePromise.then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  }));
}

function dbPutMany(valuesByStore) {
  return databasePromise.then((database) => new Promise((resolve, reject) => {
    const names = Object.keys(valuesByStore);
    const transaction = database.transaction(names, 'readwrite');
    for (const [storeName, value] of Object.entries(valuesByStore)) {
      if (value === null) transaction.objectStore(storeName).delete(valuesByStore.id);
      else transaction.objectStore(storeName).put(value);
    }
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  }));
}

function dbSaveCardAndQueue(card, outbox) {
  return databasePromise.then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(['cards', 'outbox'], 'readwrite');
    transaction.objectStore('cards').put(card);
    transaction.objectStore('outbox').put(outbox);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  }));
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateTime(date, time) {
  return `${date}T${time}`;
}

function makeId() {
  return crypto.randomUUID();
}

function cardId(locationId, workDate) {
  return `${locationId}:${workDate}`;
}

function newCard(locationId, workDate) {
  return {
    id: cardId(locationId, workDate),
    locationId,
    workDate,
    status: 'open',
    createdAt: new Date().toISOString(),
    closedAt: null,
    previousCash: null,
    countedCash: null,
    cashVerifiedBy: '',
    workers: [],
    fuel: [],
    purchases: [],
    doughBatches: [],
    sales: [],
    ownerCash: [],
    localRevision: 0,
    serverVersion: 0,
    syncState: 'local',
  };
}

function selectedLocation() {
  return document.querySelector('#locationSelect').value;
}

function selectedWorkDate() {
  return document.querySelector('#workDateInput').value;
}

function locationName(id) {
  return LOCATIONS.find((location) => location.id === id)?.name ?? id;
}

function money(value) {
  return `${Number(value || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
}

function hoursWorked(worker) {
  if (!worker.checkIn || !worker.checkOut) return 0;
  const start = new Date(worker.checkIn);
  let end = new Date(worker.checkOut);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end < start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  return Math.max(0, (end - start) / 3_600_000);
}

function dailyTurnover(card) {
  return card.sales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0);
}

function payFor(worker, card) {
  const hours = hoursWorked(worker);
  let rate = 0;
  if (worker.role === 'kucharz') rate = 17 + Math.max(0, Math.floor((dailyTurnover(card) - 4000) / 500));
  if (worker.role === 'pomoc') rate = 15 + Math.max(0, Math.floor((dailyTurnover(card) - 4000) / 1000));
  if (worker.role === 'kierowca') rate = 13 + (hours > 0 && Number(worker.trips || 0) / hours >= 3 ? 1 : 0);
  return { hours, rate, amount: Math.round(hours * rate * 100) / 100 };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setFormValue(form, name, value) {
  const field = form.elements.namedItem(name);
  if (field) field.value = value ?? '';
}

function getFormValue(form, name) {
  return form.elements.namedItem(name).value.trim();
}

function setNotice(message, isError = false) {
  const notice = document.querySelector('#managerNotice');
  if (notice) {
    notice.textContent = message;
    notice.style.color = isError ? '#a33b32' : '';
  }
}

function showSyncAlert(title, message, conflict = false) {
  const alert = document.querySelector('#syncAlert');
  alert.classList.remove('hidden', 'conflict');
  if (conflict) alert.classList.add('conflict');
  document.querySelector('#syncAlertTitle').textContent = title;
  document.querySelector('#syncAlertMessage').textContent = message;
  document.querySelector('#conflictActions').classList.toggle('hidden', !conflict);
}

function hideSyncAlert() {
  document.querySelector('#syncAlert').classList.add('hidden');
  document.querySelector('#conflictActions').classList.add('hidden');
}

async function updateSyncStatus() {
  const queue = await dbGetAll('outbox');
  const pending = queue.length;
  const conflicts = queue.filter((item) => item.state === 'conflict').length;
  const syncText = document.querySelector('#syncText');
  if (conflicts) syncText.textContent = `${conflicts} konflikt do weryfikacji`;
  else if (pending) syncText.textContent = `${pending} karta(y) oczekuje na wysłanie`;
  else syncText.textContent = 'Wszystko zsynchronizowane';
  document.querySelector('#connectionDot').className = `dot ${navigator.onLine ? 'online' : 'offline'}`;
  document.querySelector('#connectionText').textContent = navigator.onLine ? 'Połączenie dostępne' : 'Praca offline';

  if (currentCard) {
    currentOutbox = await dbGet('outbox', currentCard.id);
    renderStatus();
  }
  if (currentOutbox?.state === 'conflict') {
    showSyncAlert(
      'Konflikt synchronizacji',
      'Karta została zmieniona na innym urządzeniu. Wybierz wersję po sprawdzeniu różnic.',
      true,
    );
  } else if (conflicts) {
    showSyncAlert('Konflikt synchronizacji', 'Co najmniej jedna karta wymaga weryfikacji na stanowisku, które ją edytowało.');
  } else if (pending && !navigator.onLine) {
    showSyncAlert(
      'Dane zapisane lokalnie',
      'Karta pozostaje na tym komputerze i wyśle się po odzyskaniu połączenia. Wysyłka o 6:00 wymaga uruchomionej aplikacji i dostępu do sieci.',
    );
  } else if (!conflicts) {
    hideSyncAlert();
  }
}

function renderStatus() {
  const status = document.querySelector('#cardStatus');
  if (!currentCard) return;
  status.classList.toggle('closed', currentCard.status === 'closed');
  const stateLabel = currentOutbox?.state === 'conflict'
    ? 'Konflikt — wymaga weryfikacji'
    : currentOutbox
      ? 'Oczekuje na synchronizację'
      : currentCard.serverVersion
        ? `Zsynchronizowana · wersja ${currentCard.serverVersion}`
        : 'Zapis lokalny';
  const state = document.createElement('span');
  state.textContent = stateLabel;
  const details = document.createElement('span');
  details.textContent = currentCard.status === 'closed' ? 'Dzień zamknięty' : 'Dzień otwarty';
  status.replaceChildren(details, state);
  const closed = currentCard.status === 'closed';
  for (const form of document.querySelectorAll('#pointView form')) {
    for (const control of form.elements) control.disabled = closed;
  }
  document.querySelector('#closeDayButton').disabled = closed;
}

async function saveCurrentCard(allowClosed = false) {
  if (!currentCard || (currentCard.status === 'closed' && !allowClosed)) return;
  currentCard.localRevision = Number(currentCard.localRevision || 0) + 1;
  currentCard.syncState = 'pending';
  const outbox = {
    id: currentCard.id,
    card: structuredClone(currentCard),
    expectedVersion: Number(currentCard.serverVersion || 0),
    state: 'pending',
  };
  await dbSaveCardAndQueue(currentCard, outbox);
  currentOutbox = outbox;
  renderAll();
  await updateSyncStatus();
  void attemptSync(outbox.id);
}

async function attemptSync(id) {
  if (!navigator.onLine || syncInFlight.has(id)) return;
  const outbox = await dbGet('outbox', id);
  if (!outbox || outbox.state === 'conflict') return;
  syncInFlight.add(id);
  try {
    const response = await fetch(`/api/cards/${encodeURIComponent(outbox.card.locationId)}/${outbox.card.workDate}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: outbox.expectedVersion, card: outbox.card }),
    });
    const result = await response.json();
    if (response.status === 409) {
      const conflicted = { ...outbox, state: 'conflict', remote: result.current };
      const local = await dbGet('cards', id);
      if (local) {
        local.syncState = 'conflict';
        await dbSaveCardAndQueue(local, conflicted);
        if (currentCard?.id === id) currentCard = local;
      } else {
        await dbPutMany({ outbox: conflicted });
      }
      currentOutbox = currentCard?.id === id ? conflicted : currentOutbox;
      await updateSyncStatus();
      return;
    }
    if (!response.ok) throw new Error(result.error || `Błąd synchronizacji (${response.status}).`);

    const database = await databasePromise;
    let retry = false;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['cards', 'outbox'], 'readwrite');
      const cards = transaction.objectStore('cards');
      const outboxStore = transaction.objectStore('outbox');
      const cardRequest = cards.get(id);
      const queueRequest = outboxStore.get(id);
      let cardLoaded = false;
      let queueLoaded = false;
      let localCard;
      let queueItem;
      const commit = () => {
        if (!cardLoaded || !queueLoaded) return;
        if (localCard) {
          localCard.serverVersion = result.version;
          localCard.syncState = queueItem?.card.localRevision === outbox.card.localRevision ? 'synced' : 'pending';
          cards.put(localCard);
          if (queueItem?.card.localRevision === outbox.card.localRevision) {
            outboxStore.delete(id);
          } else if (queueItem) {
            queueItem.expectedVersion = result.version;
            outboxStore.put(queueItem);
            retry = true;
          }
        }
      };
      cardRequest.onsuccess = () => {
        localCard = cardRequest.result;
        cardLoaded = true;
        commit();
      };
      queueRequest.onsuccess = () => {
        queueItem = queueRequest.result;
        queueLoaded = true;
        commit();
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    if (currentCard?.id === id) {
      currentCard.serverVersion = result.version;
      currentOutbox = await dbGet('outbox', id);
      if (currentOutbox && currentOutbox.card.localRevision === currentCard.localRevision) currentCard.syncState = 'pending';
      else currentCard.syncState = 'synced';
      renderAll();
    }
    await updateSyncStatus();
    if (retry) void attemptSync(id);
  } catch (error) {
    console.error('Synchronizacja nie powiodła się:', error);
    if (error instanceof TypeError || !navigator.onLine) {
      showSyncAlert('Brak połączenia z serwerem', 'Zmiany pozostają zapisane lokalnie; aplikacja ponowi wysyłkę automatycznie.');
    } else {
      showSyncAlert('Błąd synchronizacji', error.message || 'Nie udało się wysłać karty.');
    }
  } finally {
    syncInFlight.delete(id);
    if (currentCard?.id === id) {
      currentOutbox = await dbGet('outbox', id);
      renderStatus();
    }
  }
}

async function syncPendingCards() {
  const queue = await dbGetAll('outbox');
  for (const item of queue) {
    if (item.state === 'pending') void attemptSync(item.id);
  }
  await updateSyncStatus();
}

async function resolveConflict(useLocal) {
  if (!currentCard || !currentOutbox?.remote) return;
  const remote = currentOutbox.remote;
  if (useLocal) {
    const confirmed = window.confirm('Czy na pewno po sprawdzeniu zachować tę lokalną wersję? Nadpisze ona wersję serwera.');
    if (!confirmed) return;
    currentCard.serverVersion = remote.version;
    currentCard.syncState = 'pending';
    currentOutbox = {
      id: currentCard.id,
      card: structuredClone(currentCard),
      expectedVersion: remote.version,
      state: 'pending',
    };
    await dbSaveCardAndQueue(currentCard, currentOutbox);
    renderAll();
    void attemptSync(currentCard.id);
  } else {
    currentCard = {
      ...remote.card,
      id: remote.id,
      serverVersion: remote.version,
      syncState: 'synced',
    };
    currentOutbox = null;
    await dbPutMany({ cards: currentCard });
    await dbDelete('outbox', currentCard.id);
    renderAll();
  }
  await updateSyncStatus();
}

async function loadCurrentCard() {
  const locationId = selectedLocation();
  const workDate = selectedWorkDate();
  if (!locationId || !workDate) return;
  const id = cardId(locationId, workDate);
  const local = await dbGet('cards', id);
  const queued = await dbGet('outbox', id);
  let loadWarning = '';
  if (queued) {
    currentCard = local ?? queued.card;
    currentOutbox = queued;
    renderAll();
    await updateSyncStatus();
    if (queued.state === 'pending') void attemptSync(id);
    return;
  }

  try {
    const response = await fetch(`/api/cards/${encodeURIComponent(locationId)}/${workDate}`);
    if (response.ok) {
      const remote = await response.json();
      currentCard = {
        ...remote.card,
        id: remote.id,
        serverVersion: remote.version,
        syncState: 'synced',
      };
      currentOutbox = null;
      await dbPutMany({ cards: currentCard });
    } else if (response.status === 404) {
      currentCard = local ?? newCard(locationId, workDate);
      currentOutbox = null;
      if (!local) {
        const previousDate = shiftDate(workDate, -1);
        const previousLocal = await dbGet('cards', cardId(locationId, previousDate));
        if (previousLocal?.countedCash !== null && previousLocal?.countedCash !== undefined) {
          currentCard.previousCash = previousLocal.countedCash;
        } else {
          const previousResponse = await fetch(`/api/cards/${encodeURIComponent(locationId)}/${previousDate}`);
          if (previousResponse.ok) {
            const previousRemote = await previousResponse.json();
            if (previousRemote.card.countedCash !== null && previousRemote.card.countedCash !== undefined) {
              currentCard.previousCash = previousRemote.card.countedCash;
            }
          } else if (previousResponse.status !== 404) {
            throw new Error(`Nie udało się odczytać kasetki z ${previousDate}.`);
          }
        }
      }
    } else {
      throw new Error(`Nie udało się pobrać karty (${response.status}).`);
    }
  } catch (error) {
    if (!local) {
      currentCard = newCard(locationId, workDate);
      loadWarning = navigator.onLine
        ? `Nie udało się pobrać karty z serwera: ${error.message}`
        : 'Nowa Karta Dnia zostanie zapisana lokalnie i zsynchronizuje się po odzyskaniu połączenia.';
    } else {
      currentCard = local;
      loadWarning = navigator.onLine ? `Nie udało się odświeżyć karty: ${error.message}` : '';
    }
    currentOutbox = null;
  }
  renderAll();
  await updateSyncStatus();
  if (loadWarning) showSyncAlert(navigator.onLine ? 'Błąd pobierania Karty Dnia' : 'Praca offline', loadWarning);
}

function renderCash() {
  const form = document.querySelector('#cashForm');
  setFormValue(form, 'previousCash', currentCard.previousCash);
  setFormValue(form, 'countedCash', currentCard.countedCash);
  setFormValue(form, 'cashVerifiedBy', currentCard.cashVerifiedBy);
}

function renderWorkers() {
  const list = document.querySelector('#workersList');
  list.replaceChildren();
  const drivers = currentCard.workers.filter((worker) => worker.role === 'kierowca');
  const fuelSelect = document.querySelector('#fuelForm select[name="workerId"]');
  fuelSelect.replaceChildren();
  for (const driver of drivers) {
    const option = el('option', '', driver.name);
    option.value = driver.id;
    fuelSelect.append(option);
  }
  if (!drivers.length) {
    const option = el('option', '', 'Najpierw dodaj kierowcę');
    option.value = '';
    fuelSelect.append(option);
  }
  for (const worker of currentCard.workers) {
    const row = el('div', 'record');
    const main = el('div', 'record-main');
    const roleName = worker.role === 'pomoc' ? 'Pomoc kuchenna' : worker.role[0].toUpperCase() + worker.role.slice(1);
    const pay = payFor(worker, currentCard);
    main.append(
      el('div', 'record-title', `${worker.name} · ${roleName}`),
      el('div', 'record-meta', `${worker.checkIn ? new Date(worker.checkIn).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '—'}–${worker.checkOut ? new Date(worker.checkOut).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : 'w pracy'} · ${worker.vehicleId ? worker.vehicleId.replace('-', ' ').toUpperCase() : 'bez auta'}${worker.role === 'kierowca' ? ` · ${worker.trips || 0} kursów · kontrola: ${Object.values(worker.vehicleChecks || {}).filter(Boolean).length}/5` : ''}`),
    );
    const actions = el('div', 'record-actions');
    actions.append(el('span', 'amount', `${pay.hours.toFixed(2)} h · ${pay.rate} zł/h · ${money(pay.amount)}`));
    if (!worker.checkOut && currentCard.status !== 'closed') {
      const checkout = el('button', 'small-button', 'Wyjście teraz');
      checkout.type = 'button';
      checkout.addEventListener('click', () => {
        worker.checkOut = localDateTime(localDateString(), new Date().toTimeString().slice(0, 5));
        void saveCurrentCard();
      });
      actions.append(checkout);
    }
    if (worker.role === 'kierowca' && currentCard.status !== 'closed') {
      const tripsButton = el('button', 'small-button', 'Zmień kursy');
      tripsButton.type = 'button';
      tripsButton.addEventListener('click', () => {
        const value = window.prompt('Podaj łączną liczbę kursów kierowcy za ten dzień:', String(worker.trips || 0));
        if (value === null) return;
        const trips = Number(value);
        if (!Number.isInteger(trips) || trips < 0) {
          showSyncAlert('Nieprawidłowa liczba kursów', 'Wpisz nieujemną liczbę całkowitą.', true);
          return;
        }
        worker.trips = trips;
        void saveCurrentCard();
      });
      actions.append(tripsButton);
    }
    if (currentCard.status !== 'closed') {
      const removeButton = el('button', 'small-button', 'Usuń');
      removeButton.type = 'button';
      removeButton.addEventListener('click', () => {
        if (!window.confirm(`Usunąć wpis pracownika ${worker.name}? Powiązane tankowania tego pracownika również zostaną usunięte.`)) return;
        currentCard.workers = currentCard.workers.filter((item) => item.id !== worker.id);
        currentCard.fuel = currentCard.fuel.filter((item) => item.workerId !== worker.id);
        void saveCurrentCard();
      });
      actions.append(removeButton);
    }
    row.append(main, actions);
    list.append(row);
  }
  if (!currentCard.workers.length) list.append(el('p', 'empty-inline', 'Nie dodano jeszcze pracowników.'));
}

function renderRecords(elementId, records, titleFor, metaFor, onRemove) {
  const list = document.querySelector(`#${elementId}`);
  list.replaceChildren();
  if (!records.length) {
    list.append(el('p', 'empty-inline', 'Brak wpisów.'));
    return;
  }
  for (const record of records) {
    const row = el('div', 'record');
    const main = el('div', 'record-main');
    main.append(el('div', 'record-title', titleFor(record)), el('div', 'record-meta', metaFor(record)));
    const actions = el('div', 'record-actions');
    if (record.amount !== undefined) actions.append(el('span', 'amount', money(record.amount)));
    if (currentCard.status !== 'closed') {
      const remove = el('button', 'small-button', 'Usuń');
      remove.type = 'button';
      remove.addEventListener('click', () => onRemove(record.id));
      actions.append(remove);
    }
    row.append(main, actions);
    list.append(row);
  }
}

function renderAll() {
  if (!currentCard) return;
  renderStatus();
  renderCash();
  renderWorkers();
  renderRecords('fuelList', currentCard.fuel,
    (item) => `${currentCard.workers.find((worker) => worker.id === item.workerId)?.name ?? 'Kierowca'} · ${money(item.amount)}`,
    (item) => `${item.liters ? `${item.liters} l · ` : ''}Faktura: ${item.invoiceNumber || 'brak numeru'}`,
    (id) => removeRecord('fuel', id));
  renderRecords('purchasesList', currentCard.purchases,
    (item) => `${item.vendor} · ${money(item.amount)}`,
    (item) => `${item.buyer || 'Kupujący niepodany'} · ${item.paidFromLabel}${item.receiptNumber ? ` · dokument ${item.receiptNumber}` : ''}`,
    (id) => removeRecord('purchases', id));
  renderRecords('doughList', currentCard.doughBatches,
    (item) => `Małe ${item.small} · średnie ${item.medium} · duże ${item.large}`,
    (item) => item.label || 'Partia ciasta',
    (id) => removeRecord('doughBatches', id));
  const salesList = document.querySelector('#salesSummary');
  salesList.replaceChildren();
  if (!currentCard.sales.length) salesList.append(el('p', 'empty-inline', 'Brak wpisów sprzedaży.'));
  const groupedSales = new Map();
  for (const sale of currentCard.sales) {
    const key = `${sale.channel} · ${sale.payment}`;
    if (!groupedSales.has(key)) groupedSales.set(key, []);
    groupedSales.get(key).push(sale);
  }
  for (const [key, sales] of groupedSales) {
    const group = el('div', 'record');
    group.append(
      el('div', 'record-title', key),
      el('span', 'amount', money(sales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0))),
    );
    salesList.append(group);
    for (const sale of sales) {
      const detail = el('div', 'record sales-detail');
      detail.append(
        el('div', 'record-meta', `Pozycja: ${money(sale.amount)}`),
      );
      if (currentCard.status !== 'closed') {
        const remove = el('button', 'small-button', 'Usuń');
        remove.type = 'button';
        remove.addEventListener('click', () => void removeRecord('sales', sale.id));
        detail.append(remove);
      }
      salesList.append(detail);
    }
  }
  renderRecords('ownerCashList', currentCard.ownerCash,
    (item) => money(item.amount),
    (item) => item.note || 'Wpłata szefów',
    (id) => removeRecord('ownerCash', id));
}

async function removeRecord(collection, id) {
  currentCard[collection] = currentCard[collection].filter((record) => record.id !== id);
  await saveCurrentCard();
}

function addRecordHandler(formId, buildRecord, collection) {
  document.querySelector(`#${formId}`).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentCard || currentCard.status === 'closed') return;
    try {
      const form = event.currentTarget;
      const record = buildRecord(new FormData(form), form);
      if (collection) currentCard[collection].push(record);
      else Object.assign(currentCard, record);
      form.reset();
      if (formId === 'workerForm') {
        form.elements.checkIn.value = localDateTime(currentCard.workDate, '14:00');
        form.elements.trips.value = '0';
      }
      if (formId === 'doughForm') {
        form.elements.small.value = '0';
        form.elements.medium.value = '0';
        form.elements.large.value = '0';
      }
      await saveCurrentCard();
    } catch (error) {
      console.error(error);
      showSyncAlert('Nie udało się zapisać wpisu', error.message || 'Sprawdź dane i spróbuj ponownie.', true);
    }
  });
}

function setUpForms() {
  addRecordHandler('cashForm', (_data, form) => ({
    previousCash: form.elements.previousCash.value === '' ? null : Number(form.elements.previousCash.value),
    countedCash: form.elements.countedCash.value === '' ? null : Number(form.elements.countedCash.value),
    cashVerifiedBy: getFormValue(form, 'cashVerifiedBy'),
  }));

  addRecordHandler('workerForm', (_data, form, ) => {
    const role = getFormValue(form, 'role');
    const checks = {
      tires: form.elements.checkTires.checked,
      lights: form.elements.checkLights.checked,
      brakes: form.elements.checkBrakes.checked,
      fluids: form.elements.checkFluids.checked,
      damage: form.elements.checkDamage.checked,
    };
    return {
      id: makeId(),
      name: getFormValue(form, 'name'),
      employeeId: getFormValue(form, 'employeeId'),
      role,
      checkIn: form.elements.checkIn.value,
      checkOut: '',
      vehicleId: role === 'kierowca' ? getFormValue(form, 'vehicleId') : '',
      trips: role === 'kierowca' ? Number(form.elements.trips.value || 0) : 0,
      vehicleChecks: role === 'kierowca' ? checks : {},
    };
  }, 'workers');

  addRecordHandler('fuelForm', (_data, form) => ({
    id: makeId(),
    workerId: getFormValue(form, 'workerId'),
    amount: Number(form.elements.amount.value),
    liters: form.elements.liters.value ? Number(form.elements.liters.value) : null,
    invoiceNumber: getFormValue(form, 'invoiceNumber'),
  }), 'fuel');

  const paidFromLabels = {
    customer_cash: 'Gotówka od klientów',
    personal: 'Prywatne środki kierowcy',
    point_cash: 'Kasa punktu',
    company_card: 'Karta firmowa',
  };
  addRecordHandler('purchaseForm', (_data, form) => ({
    id: makeId(),
    vendor: getFormValue(form, 'vendor'),
    amount: Number(form.elements.amount.value),
    paidFrom: getFormValue(form, 'paidFrom'),
    paidFromLabel: paidFromLabels[getFormValue(form, 'paidFrom')],
    buyer: getFormValue(form, 'buyer'),
    receiptNumber: getFormValue(form, 'receiptNumber'),
  }), 'purchases');

  addRecordHandler('doughForm', (_data, form) => ({
    id: makeId(),
    label: getFormValue(form, 'label'),
    small: Number(form.elements.small.value),
    medium: Number(form.elements.medium.value),
    large: Number(form.elements.large.value),
  }), 'doughBatches');

  addRecordHandler('salesForm', (_data, form) => ({
    id: makeId(),
    channel: getFormValue(form, 'channel'),
    payment: getFormValue(form, 'payment'),
    amount: Number(form.elements.amount.value),
  }), 'sales');

  addRecordHandler('ownerCashForm', (_data, form) => ({
    id: makeId(),
    amount: Number(form.elements.amount.value),
    note: getFormValue(form, 'note'),
  }), 'ownerCash');

  document.querySelector('#workerForm select[name="role"]').addEventListener('change', (event) => {
    const isDriver = event.currentTarget.value === 'kierowca';
    document.querySelector('.checklist').classList.toggle('hidden', !isDriver);
    document.querySelector('#workerForm select[name="vehicleId"]').disabled = !isDriver;
    document.querySelector('#workerForm input[name="trips"]').disabled = !isDriver;
    for (const input of document.querySelectorAll('.checklist input')) input.disabled = !isDriver;
  });
}

async function closeCurrentDay() {
  if (!currentCard || currentCard.status === 'closed') return;
  if (!currentCard.cashVerifiedBy || currentCard.countedCash === null) {
    showSyncAlert('Brak weryfikacji kasetki', 'Przed zamknięciem wpisz przeliczoną gotówkę i osobę weryfikującą.', true);
    return;
  }
  if (currentCard.workers.some((worker) => !worker.checkOut)) {
    showSyncAlert('Niepełna lista czasu pracy', 'Zapisz godzinę wyjścia każdego pracownika przed zamknięciem dnia.', true);
    return;
  }
  if (!currentCard.workers.some((worker) => worker.role === 'kucharz')) {
    showSyncAlert('Brak kucharza na zmianie', 'Dodaj kucharza do Karty Dnia przed zamknięciem.', true);
    return;
  }
  const verifyingCook = currentCard.workers.find((worker) => worker.role === 'kucharz'
    && worker.name.trim().localeCompare(currentCard.cashVerifiedBy.trim(), 'pl', { sensitivity: 'accent' }) === 0);
  if (!verifyingCook) {
    showSyncAlert('Nieprawidłowa weryfikacja kasetki', 'Osoba weryfikująca musi być kucharzem wpisanym na tej Karcie Dnia.', true);
    return;
  }
  if (!window.confirm('Zamknąć Kartę Dnia? Po zamknięciu nie będzie można jej edytować.')) return;
  currentCard.status = 'closed';
  currentCard.closedAt = new Date().toISOString();
  await saveCurrentCard(true);
}

function mondayOf(value) {
  const date = new Date(`${value}T12:00:00`);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return localDateString(date);
}

function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function buildWeeklyRows(cards) {
  const rows = new Map();
  for (const card of cards) {
    for (const worker of card.workers || []) {
      const key = worker.employeeId?.trim() || `${worker.role}:${worker.name.trim().toLocaleLowerCase('pl-PL')}`;
      const row = rows.get(key) || { name: worker.name, role: worker.role, days: new Map(), hours: 0, amount: 0 };
      const pay = payFor(worker, card);
      row.days.set(card.workDate, { hours: pay.hours, rate: pay.rate, amount: pay.amount });
      row.hours = Math.round((row.hours + pay.hours) * 100) / 100;
      row.amount = Math.round((row.amount + pay.amount) * 100) / 100;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
}

function reportEmployeeKey(worker) {
  return worker.employeeId?.trim()
    || `${worker.role}:${worker.name.trim().toLocaleLowerCase('pl-PL')}`;
}

function appendCell(row, value, className = '', tagName = 'td') {
  const cell = document.createElement(tagName);
  if (className) cell.className = className;
  if (value instanceof Node) cell.append(value);
  else cell.textContent = value;
  row.append(cell);
  return cell;
}

function renderManager() {
  const start = document.querySelector('#weekStartInput').value;
  const dates = Array.from({ length: 7 }, (_, index) => shiftDate(start, index));
  const cardBody = document.querySelector('#managerCardsBody');
  cardBody.replaceChildren();
  const sortedCards = [...managerCards].sort((a, b) => a.workDate.localeCompare(b.workDate) || a.locationId.localeCompare(b.locationId));
  document.querySelector('#managerEmpty').classList.toggle('hidden', sortedCards.length > 0);
  for (const record of sortedCards) {
    const row = document.createElement('tr');
    const card = record.card;
    appendCell(row, record.workDate);
    appendCell(row, locationName(record.locationId));
    const status = el('span', `status-pill ${card.status === 'closed' ? '' : 'open'}`, card.status === 'closed' ? 'Zamknięta' : 'Otwarta');
    appendCell(row, status);
    appendCell(row, money(dailyTurnover(card)));
    appendCell(row, (card.workers || []).map((worker) => worker.name).join(', ') || '—');
    appendCell(row, card.closedAt ? new Date(card.closedAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '—');
    const detailCell = document.createElement('td');
    const detailButton = el('button', 'small-button', 'Podgląd');
    detailButton.type = 'button';
    detailButton.addEventListener('click', () => {
      selectedManagerCardId = record.id;
      renderManager();
    });
    detailCell.append(detailButton);
    row.append(detailCell);
    cardBody.append(row);
  }
  const selectedRecord = sortedCards.find((record) => record.id === selectedManagerCardId);
  const detail = document.querySelector('#managerCardDetail');
  if (selectedRecord) {
    renderManagerCardDetails(selectedRecord);
    detail.classList.remove('hidden');
  } else {
    detail.classList.add('hidden');
    selectedManagerCardId = '';
  }

  const workers = buildWeeklyRows(managerCards.map((record) => record.card));
  const head = document.querySelector('#weeklyHead');
  const body = document.querySelector('#weeklyBody');
  const foot = document.querySelector('#weeklyFoot');
  head.replaceChildren();
  body.replaceChildren();
  foot.replaceChildren();
  document.querySelector('#weeklyEmpty').classList.toggle('hidden', workers.length > 0);
  const header = document.createElement('tr');
  appendCell(header, 'Imię i nazwisko', '', 'th');
  appendCell(header, 'Rola', '', 'th');
  for (const date of dates) appendCell(header, new Date(`${date}T12:00:00`).toLocaleDateString('pl-PL', { weekday: 'short', day: '2-digit', month: '2-digit' }), '', 'th');
  appendCell(header, 'Godziny', '', 'th');
  appendCell(header, 'Tygodniówka', '', 'th');
  appendCell(header, 'Wypłata', '', 'th');
  head.append(header);

  let totalHours = 0;
  let totalPay = 0;
  for (const worker of workers) {
    const row = document.createElement('tr');
    appendCell(row, worker.name);
    appendCell(row, worker.role === 'pomoc' ? 'Pomoc kuchenna' : worker.role);
    for (const date of dates) {
      const day = worker.days.get(date);
      const cell = document.createElement('td');
      cell.className = 'weekly-cell';
      if (day) {
        cell.append(el('strong', '', `${day.hours.toFixed(2)} h`));
        cell.append(el('span', '', `${day.rate} zł/h · ${money(day.amount)}`));
      } else {
        cell.textContent = '—';
      }
      row.append(cell);
    }
    appendCell(row, `${worker.hours.toFixed(2)} h`, 'weekly-total');
    appendCell(row, money(worker.amount), 'weekly-total');
    const payoutCell = document.createElement('td');
    const payout = managerPayouts.find((item) => item.employeeKey === reportEmployeeKey(worker));
    if (payout) {
      payoutCell.textContent = `Wypłacono ${money(payout.amount)} · ${payout.paymentMethod === 'gotowka' ? 'gotówka' : 'przelew'} · ${new Date(payout.paidAt).toLocaleDateString('pl-PL')}`;
    } else if (payrollApproval?.isCurrent) {
      const payButton = el('button', 'small-button', 'Zapisz wypłatę');
      payButton.type = 'button';
      payButton.addEventListener('click', () => void recordPayout(worker));
      payoutCell.append(payButton);
    } else {
      payoutCell.textContent = 'Po zatwierdzeniu';
    }
    row.append(payoutCell);
    body.append(row);
    totalHours += worker.hours;
    totalPay += worker.amount;
  }
  if (workers.length) {
    const footer = document.createElement('tr');
    appendCell(footer, 'Suma tygodnia', 'weekly-total');
    appendCell(footer, '');
    for (let index = 0; index < dates.length; index += 1) appendCell(footer, '');
    appendCell(footer, `${totalHours.toFixed(2)} h`, 'weekly-total');
    appendCell(footer, money(totalPay), 'weekly-total');
    appendCell(footer, '');
    foot.append(footer);
  }

  const approvalLabel = document.querySelector('#payrollApproval');
  if (!payrollApproval) {
    approvalLabel.textContent = 'Tygodniówka nie została zatwierdzona.';
    approvalLabel.classList.remove('approval-stale');
  } else {
    const when = new Date(payrollApproval.approvedAt).toLocaleString('pl-PL');
    const state = payrollApproval.isCurrent ? 'zatwierdzono' : 'zatwierdzono, ale dane od tego czasu uległy zmianie';
    const snapshot = payrollApproval.snapshot;
    approvalLabel.textContent = `Wersja ${state} przez ${payrollApproval.managerName} · ${when} · ${snapshot.employeeCount} osób · ${money(snapshot.totalAmount)}.`;
    approvalLabel.classList.toggle('approval-stale', !payrollApproval.isCurrent);
  }
}

function renderManagerCardDetails(record) {
  const card = record.card;
  document.querySelector('#managerCardDetailTitle').textContent = `${locationName(record.locationId)} · ${record.workDate}`;
  const body = document.querySelector('#managerCardDetailBody');
  body.replaceChildren();
  const addBlock = (title, lines) => {
    const block = el('div', 'detail-block');
    block.append(el('strong', '', title));
    for (const line of lines) block.append(el('p', '', line));
    body.append(block);
  };
  const cashDifference = card.countedCash === null || card.previousCash === null
    ? 'Różnica: —'
    : `Różnica: ${money(Number(card.countedCash) - Number(card.previousCash))}`;
  addBlock('Kasetka', [
    `Poprzedni stan: ${card.previousCash === null ? '—' : money(card.previousCash)}`,
    `Przeliczono: ${card.countedCash === null ? '—' : money(card.countedCash)}`,
    cashDifference,
    `Weryfikował(a): ${card.cashVerifiedBy || '—'}`,
  ]);
  addBlock('Zespół i wynagrodzenie', card.workers.length
    ? card.workers.map((worker) => {
      const pay = payFor(worker, card);
      const role = worker.role === 'pomoc' ? 'Pomoc kuchenna' : worker.role;
      const vehicle = worker.vehicleId ? ` · ${worker.vehicleId.replace('-', ' ').toUpperCase()}` : '';
      const checks = worker.role === 'kierowca'
        ? ` · ${worker.trips || 0} kursów · kontrola auta ${Object.values(worker.vehicleChecks || {}).filter(Boolean).length}/5`
        : '';
      return `${worker.name} (${role}) · wejście ${worker.checkIn || '—'} · wyjście ${worker.checkOut || '—'} · ${pay.hours.toFixed(2)} h × ${pay.rate} zł/h = ${money(pay.amount)}${vehicle}${checks}`;
    })
    : ['Brak pracowników.']);
  const groupedSales = new Map();
  for (const sale of card.sales) {
    const key = `${sale.channel} · ${sale.payment}`;
    groupedSales.set(key, (groupedSales.get(key) || 0) + Number(sale.amount || 0));
  }
  addBlock('Sprzedaż', groupedSales.size
    ? [...groupedSales].map(([key, amount]) => `${key}: ${money(amount)}`)
    : ['Brak wpisów.']);
  addBlock('Zakupy', card.purchases.length
    ? card.purchases.map((item) => `${item.vendor}: ${money(item.amount)} · ${item.paidFromLabel || item.paidFrom}${item.buyer ? ` · ${item.buyer}` : ''}${item.receiptNumber ? ` · dok. ${item.receiptNumber}` : ''}`)
    : ['Brak wpisów.']);
  addBlock('Tankowania', card.fuel.length
    ? card.fuel.map((item) => `${card.workers.find((worker) => worker.id === item.workerId)?.name || 'Kierowca'}: ${money(item.amount)}${item.liters ? ` · ${item.liters} l` : ''}${item.invoiceNumber ? ` · faktura ${item.invoiceNumber}` : ''}`)
    : ['Brak wpisów.']);
  addBlock('Partie ciasta', card.doughBatches.length
    ? card.doughBatches.map((item) => `${item.label || 'Partia'}: małe ${item.small}, średnie ${item.medium}, duże ${item.large}`)
    : ['Brak wpisów.']);
  addBlock('Gotówka szefów', card.ownerCash.length
    ? card.ownerCash.map((item) => `${money(item.amount)}${item.note ? ` · ${item.note}` : ''}`)
    : ['Brak wpisów.']);
  addBlock('Zamknięcie', [
    card.status === 'closed' ? `Zamknięto: ${new Date(card.closedAt).toLocaleString('pl-PL')}` : 'Karta otwarta.',
    `Łączny utarg: ${money(dailyTurnover(card))}`,
  ]);
}

async function refreshManager() {
  const start = document.querySelector('#weekStartInput').value;
  if (!start) return;
  const end = shiftDate(start, 6);
  try {
    const response = await fetch(`/api/cards?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`);
    if (!response.ok) throw new Error(`Nie udało się pobrać kart (${response.status}).`);
    managerCards = await response.json();
    const approvalResponse = await fetch(`/api/payroll-approvals?from=${encodeURIComponent(start)}`);
    if (!approvalResponse.ok) throw new Error(`Nie udało się pobrać zatwierdzenia (${approvalResponse.status}).`);
    payrollApproval = (await approvalResponse.json()).approval;
    const payoutsResponse = await fetch(`/api/payouts?from=${encodeURIComponent(start)}`);
    if (!payoutsResponse.ok) throw new Error(`Nie udało się pobrać rejestru wypłat (${payoutsResponse.status}).`);
    managerPayouts = await payoutsResponse.json();
    renderManager();
    setNotice(`Pobrano ${managerCards.length} kart · ${start} — ${end}`);
  } catch (error) {
    setNotice(`${error.message} Menadżer wymaga połączenia z serwerem.`, true);
  }
}

async function recordPayout(worker) {
  if (!payrollApproval?.isCurrent) {
    setNotice('Zatwierdź aktualną tygodniówkę przed rejestrowaniem wypłat.', true);
    return;
  }
  const managerName = document.querySelector('#managerNameInput').value.trim();
  if (!managerName) {
    setNotice('Wpisz imię i nazwisko menadżera realizującego wypłatę.', true);
    document.querySelector('#managerNameInput').focus();
    return;
  }
  const confirmed = window.confirm(`Czy potwierdzasz faktyczną wypłatę ${money(worker.amount)} dla ${worker.name}?`);
  if (!confirmed) return;
  try {
    const response = await fetch('/api/payouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        weekStart: document.querySelector('#weekStartInput').value,
        employeeKey: reportEmployeeKey(worker),
        managerName,
        paymentMethod: document.querySelector('#payoutMethodSelect').value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Nie udało się zarejestrować wypłaty (${response.status}).`);
    managerPayouts.push(result.payout);
    renderManager();
    setNotice(`Zarejestrowano wypłatę ${money(result.payout.amount)} dla ${result.payout.employeeName}.`);
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function approvePayroll() {
  const weekStart = document.querySelector('#weekStartInput').value;
  const managerName = document.querySelector('#managerNameInput').value.trim();
  if (!managerName) {
    setNotice('Wpisz imię i nazwisko menadżera zatwierdzającego.', true);
    document.querySelector('#managerNameInput').focus();
    return;
  }
  try {
    const response = await fetch('/api/payroll-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekStart, managerName }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Nie udało się zatwierdzić tygodniówki (${response.status}).`);
    payrollApproval = result.approval;
    renderManager();
    setNotice('Tygodniówka została zatwierdzona. Wypłata pozostaje do ręcznej realizacji.');
  } catch (error) {
    setNotice(error.message, true);
  }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  const start = document.querySelector('#weekStartInput').value;
  const dates = Array.from({ length: 7 }, (_, index) => shiftDate(start, index));
  const rows = [['Imię i nazwisko', 'Rola', 'Data', 'Punkt', 'Godziny', 'Stawka (zł/h)', 'Dniówka (zł)']];
  for (const worker of buildWeeklyRows(managerCards.map((record) => record.card))) {
    for (const date of dates) {
      const day = worker.days.get(date);
      if (day) rows.push([worker.name, worker.role, date, '', day.hours.toFixed(2), day.rate, day.amount.toFixed(2)]);
    }
  }
  for (const row of rows) {
    if (row[2]) {
      const record = managerCards.find((item) => item.workDate === row[2] && item.card.workers.some((worker) => worker.name === row[0]));
      if (record) row[3] = locationName(record.locationId);
    }
  }
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `vulpine-pizza-${start}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function setView(view) {
  activeView = view;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === view);
  document.querySelector('#pointView').classList.toggle('hidden', view !== 'point');
  document.querySelector('#managerView').classList.toggle('hidden', view !== 'manager');
  if (view === 'manager') void refreshManager();
}

function setUpNavigation() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.tab));
  }
  document.querySelector('#locationSelect').addEventListener('change', () => void loadCurrentCard());
  document.querySelector('#workDateInput').addEventListener('change', () => void loadCurrentCard());
  document.querySelector('#weekStartInput').addEventListener('change', (event) => {
    event.currentTarget.value = mondayOf(event.currentTarget.value);
    void refreshManager();
  });
  document.querySelector('#refreshManagerButton').addEventListener('click', () => void refreshManager());
  document.querySelector('#printButton').addEventListener('click', () => window.print());
  document.querySelector('#exportButton').addEventListener('click', exportCsv);
  document.querySelector('#approvePayrollButton').addEventListener('click', () => void approvePayroll());
  document.querySelector('#closeManagerDetail').addEventListener('click', () => {
    selectedManagerCardId = '';
    document.querySelector('#managerCardDetail').classList.add('hidden');
  });
  document.querySelector('#closeDayButton').addEventListener('click', () => void closeCurrentDay());
  document.querySelector('#useServerButton').addEventListener('click', () => void resolveConflict(false));
  document.querySelector('#keepLocalButton').addEventListener('click', () => void resolveConflict(true));
}

function configureSelectors() {
  const locationSelect = document.querySelector('#locationSelect');
  for (const location of LOCATIONS) {
    const option = el('option', '', location.name);
    option.value = location.id;
    locationSelect.append(option);
  }
  const today = localDateString();
  document.querySelector('#workDateInput').value = today;
  document.querySelector('#weekStartInput').value = mondayOf(today);
  document.querySelector('#workerForm').elements.checkIn.value = localDateTime(today, '14:00');
  document.querySelector('#workerForm select[name="vehicleId"]').disabled = true;
  document.querySelector('#workerForm input[name="trips"]').disabled = true;
  document.querySelector('.checklist').classList.add('hidden');
  for (const input of document.querySelectorAll('.checklist input')) input.disabled = true;
}

function setUpEvents() {
  window.addEventListener('online', () => {
    void updateSyncStatus();
    void syncPendingCards();
  });
  window.addEventListener('offline', () => void updateSyncStatus());
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((error) => console.error('Nie udało się zarejestrować trybu offline:', error));
  }
  try {
    const events = new EventSource('/api/events');
    events.addEventListener('card-updated', () => {
      if (activeView === 'manager') void refreshManager();
      if (activeView === 'point') void updateSyncStatus();
    });
    events.onerror = () => {
      document.querySelector('#connectionText').textContent = navigator.onLine ? 'Ponawianie połączenia…' : 'Praca offline';
    };
  } catch (error) {
    console.error('Nie udało się uruchomić podglądu na żywo:', error);
  }
  refreshTimer = window.setInterval(() => {
    if (navigator.onLine) void syncPendingCards();
  }, 15_000);
  window.addEventListener('beforeunload', () => window.clearInterval(refreshTimer));
}

async function start() {
  configureSelectors();
  setUpNavigation();
  setUpForms();
  setUpEvents();
  await databasePromise;
  await loadCurrentCard();
  await syncPendingCards();
}

start().catch((error) => {
  console.error('Nie udało się uruchomić aplikacji:', error);
  showSyncAlert('Nie udało się uruchomić aplikacji', error.message || 'Sprawdź obsługę lokalnej bazy danych w przeglądarce.', true);
});
