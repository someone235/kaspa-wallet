import { ActionTree } from 'vuex';
import { LocalStorage } from 'quasar';
import { StoreInterface } from '../index';
import { MainStateInterface } from './state';
import { SelectedNetwork } from '../../../types/custom-types';
import { DEFAULT_NETWORK } from '../../../config.json';

const localSavedNetworkVar = 'kaspa-network'; // name of key for saving network in local storage

/**
 * Returns the SHA-256 hash of the mnemonic
 * Source: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
 */
async function getUniqueId(wallet) {
  /* eslint-disable */
  const msgUint8 = new TextEncoder().encode(wallet.mnemonic); // encode as (utf-8) Uint8Array
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8); // hash the message
  /* eslint-disable */
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join(''); // convert bytes to hex string
  return hashHex;
}

const actions: ActionTree<MainStateInterface, StoreInterface> = {
  // eslint-disable-next-line
  async getWalletInfo({ commit }, wallet: any) {
    // Get network
    const network = LocalStorage.getItem(localSavedNetworkVar);
    const selectedNetwork = network || DEFAULT_NETWORK;

    // Get cache
    const uniqueId = await getUniqueId(wallet);
    commit('setUniqueId', uniqueId);
    const cache = LocalStorage.getItem(`kaspa-cache-${uniqueId}`);

    // Restore wallet and set store
    await wallet.updateNetwork(network);
    if (cache) {
      wallet.restoreCache(cache);
    }
    commit('setWalletInfo', wallet);
  },

  async setNetwork({ commit, state }, network: SelectedNetwork) {
    LocalStorage.set(localSavedNetworkVar, network);
    const { wallet } = state; // eslint-disable-line
    await wallet.updateNetwork(network); // eslint-disable-line
    // await wallet.addressDiscovery();
    commit('setWalletInfo', wallet);
  },
};

export default actions;
