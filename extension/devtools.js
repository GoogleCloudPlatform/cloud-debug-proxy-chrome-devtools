/**
 * @typedef BreakpointInfo
 * @type {object}
 * @property {string} name - user-friendly name, displayed in the UI
 * @property {string} id - ID of the breakpoint in Stackdriver Debugger
 */
// https://developer.chrome.com/extensions/devtools_panels
chrome.devtools.panels.sources.createSidebarPane('Snapshot Explorer', (extensionSidebarPane) => {
  /** @type {WebSocket} */
  let ws;
  let panelWindow;
  extensionSidebarPane.setPage('panel.html');

  // Waits for the user to submit a port, then initiates a WebSocket connection.
  extensionSidebarPane.onShown.addListener((sidebarPanelWindow) => {
    panelWindow = sidebarPanelWindow;
    panelWindow.document.getElementById('form').addEventListener('submit', (e) => {
      const port = e.target.elements.port.value;
      clearError();
      e.preventDefault();
      panelWindow.document.getElementById('init').style.display = 'none';
      panelWindow.document.getElementById('explorer').style.display = 'block';
      ws = new WebSocket(`ws://localhost:${port}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({name: 'initialized'}))
      };
      ws.onmessage = (messageEvent) => {
        if (messageEvent.name === 'updateBreakpointInfoLists') {
          renderSidebarPane(messageEvent.data)
        } else {
          renderError(`Received unknown message event: ${messageEvent}`);
        }
      };
      ws.onerror = (e) => {
        renderError(e, port);
        panelWindow.document.getElementById('explorer').style.display = 'none';
        panelWindow.document.getElementById('init').style.display = 'block';
      };
      ws.onclose = (e) => {
        renderError(e, port);
        panelWindow.document.getElementById('explorer').style.display = 'none';
        panelWindow.document.getElementById('init').style.display = 'block';
      };
    });
  });

  /** Clears the error message. */
  function clearError() {
    panelWindow.document.getElementById('error').innerHTML = '';
  }

  /**
   * Renders the given error.
   *
   * @param error - error to display
   * @param port - port of WebSocket connection
   */
  function renderError(error, port) {
    let errorMessage;
    if (error && error.code === 1006) {
      errorMessage = `WebSocket connection to 'ws://localhost:${port}/' failed. ` +
          'Please make sure that the local proxy is listening on the right port.';
    } else {
      errorMessage = JSON.stringify(error);
    }
    panelWindow.document.getElementById('error').innerHTML = errorMessage;
  }

  /**
   * Renders the Snapshot Explorer using the given breakpoint data.
   *
   * @param breakpointInfoLists - lists of pending and captured breakpoint info
   */
  function renderSidebarPane(breakpointInfoLists) {
    const {pendingBreakpointInfoList, capturedSnapshotInfoList} =
        JSON.parse(breakpointInfoLists);
    renderBreakpointInfoList(pendingBreakpointInfoList,
        panelWindow.document.getElementById('pending'));
    renderBreakpointInfoList(capturedSnapshotInfoList,
        panelWindow.document.getElementById('captured'));
    ws.send(JSON.stringify({name: 'acknowledged'}));
  }

  /**
   * Renders the list element using the given breakpoint data.
   *
   * @param {BreakpointInfo[]} breakpointInfoList - list of breakpoint info
   * @param {HTMLLIElement} listElement - <li> element in HTML
   */
  function renderBreakpointInfoList(breakpointInfoList, listElement) {
    while (listElement.lastChild) {
      listElement.removeChild(listElement.lastChild);
    }
    breakpointInfoList.forEach((breakpointInfo) => {
      listElement.appendChild(createListItemElement(breakpointInfo));
    });
  }

  /**
   * Creates a list element using the given breakpoint info.
   *
   * @param {BreakpointInfo} breakpointInfo - name and ID of the breakpoint
   * @returns {HTMLLIElement} list element for the breakpoint in HTML
   */
  function createListItemElement(breakpointInfo) {
    const listItemElement = panelWindow.document.createElement('li');
    const textElement = panelWindow.document.createTextNode(breakpointInfo.name);
    listItemElement.appendChild(textElement);
    listItemElement.addEventListener('click', () => {
      ws.send(JSON.stringify({name: 'loadSnapshot', data: breakpointInfo.id}))
    });
    return listItemElement;
  }
});
