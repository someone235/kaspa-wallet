import Mnemonic from 'bitcore-mnemonic';
import bitcore from 'bitcore-lib-cash';
import passworder from 'browser-passworder';
import { Buffer } from 'safe-buffer';
import { Network, WalletSave, Api, TxSend, PendingTransactions } from 'custom-types';
import { logger } from '../utils/logger';
import { AddressManager } from './AddressManager';
import { UtxoSet } from './UtxoSet';
import * as api from './apiHelpers';
import { DEFAULT_FEE, DEFAULT_NETWORK } from '../../config.json';

/** Class representing an HDWallet with derivable child addresses */
class Wallet {
  HDWallet: bitcore.HDPrivateKey;

  /**
   * The summed balance across all of Wallet's discovered addresses, minus amount from pending transactions.
   */
  balance: number | undefined = undefined;

  /**
   * Set by addressManager
   */
  receiveAddress: string;

  /**
   * Current network.
   */
  network: Network = DEFAULT_NETWORK;

  /**
   * A 12 word mnemonic.
   */
  mnemonic: string;

  utxoSet = new UtxoSet();

  addressManager: AddressManager;

  /* eslint-disable */
  pending: PendingTransactions = {
    transactions: {},
    get amount() {
      const transactions = Object.values(this.transactions);
      if (transactions.length === 0) return 0;
      return transactions.reduce((prev, cur) => prev + cur.amount, 0);
    },
    add(id: string, tx: { utxoIds: string[]; rawTx: string; amount: number }) {
      this.transactions[id] = tx;
    },
  };
  /* eslint-enable */

  /**
   * Transactions sorted by hash.
   */
  transactionsSorted: Api.Transaction[] = [];

  /**
   * Transaction arrays keyed by address.
   */
  transactionsStorage: Record<string, Api.Transaction[]> = {};

  /** Create a wallet.
   * @param walletSave (optional)
   * @param walletSave.privKey Saved wallet's private key.
   * @param walletSave.seedPhrase Saved wallet's seed phrase.
   */
  constructor(privKey?: string, seedPhrase?: string) {
    if (privKey && seedPhrase) {
      this.HDWallet = new bitcore.HDPrivateKey(privKey);
      this.mnemonic = seedPhrase;
    } else {
      const temp = new Mnemonic(Mnemonic.Words.ENGLISH);
      this.mnemonic = temp.toString();
      this.HDWallet = new bitcore.HDPrivateKey(temp.toHDPrivateKey().toString());
    }
    this.addressManager = new AddressManager(this.HDWallet, this.network);
    this.receiveAddress = this.addressManager.receiveAddress.next();
  }

  /**
   * Queries API for address[] UTXOs. Adds UTXOs to UTXO set. Updates wallet balance.
   * @param addresses
   */
  async updateUtxos(addresses: string[]): Promise<void> {
    logger.log('info', `Getting utxos for ${addresses.length} addresses.`);
    const utxoResults = await Promise.all(addresses.map((address) => api.getUtxos(address)));
    addresses.forEach((address, i) => {
      const { utxos } = utxoResults[i];
      logger.log('info', `${address}: ${utxos.length} UTXOs found.`);
      this.utxoSet.add(utxos, address);
    });
    this.updateBalance();
  }

  /**
   * Queries API for address[] transactions. Adds tx to transactions storage. Also sorts the entire transaction set.
   * @param addresses
   */
  async addTransactions(addresses: string[]): Promise<string[]> {
    logger.log('info', `Getting transactions for ${addresses.length} addresses.`);
    const addressesWithTx: string[] = [];
    const txResults = await Promise.all(addresses.map((address) => api.getTransactions(address)));
    addresses.forEach((address, i) => {
      const { transactions } = txResults[i];
      logger.log('info', `${address}: ${transactions.length} transactions found.`);
      if (transactions.length !== 0) {
        this.transactionsStorage[address] = transactions;
        addressesWithTx.push(address);
      }
    });
    this.transactionsSorted = Object.values(this.transactionsStorage)
      .flat(2)
      .sort(
        (a, b) => a.acceptingBlockHash > b.acceptingBlockHash // TODO: get block by hash and look up timestamp
      );
    return addressesWithTx;
  }

  /**
   * Recalculates wallet balance.
   */
  updateBalance(): void {
    this.balance = this.utxoSet.totalBalance - this.pending.amount;
  }

  /**
   * Derives receiveAddresses and changeAddresses and checks their transactions and UTXOs.
   * @param threshold stop discovering after `threshold` addresses with no activity
   */
  async addressDiscovery(threshold = 20): Promise<void> {
    const doDiscovery = async (n: number, deriveType: string, offset: number): Promise<number> => {
      const derivedObjs = this.addressManager.getAddresses(n, deriveType, offset);
      const addresses = derivedObjs.map((obj) => obj.address);
      logger.log(
        'info',
        `Fetching ${deriveType} address data for derived indices ${JSON.stringify(
          derivedObjs.map((obj) => obj.index)
        )}`
      );
      const addressesWithTx = await this.addTransactions(addresses);
      if (addressesWithTx.length === 0) {
        const lastIndexWithTx = offset - (threshold - n) - 1;
        logger.log(
          'info',
          `${deriveType}Address discovery complete. Last activity on address #${lastIndexWithTx}. No activity from ${deriveType}#${
            lastIndexWithTx + 1
          }~${lastIndexWithTx + threshold + 1}.`
        );
        return lastIndexWithTx;
      }
      const newN =
        derivedObjs
          .filter((obj) => addressesWithTx.indexOf(obj.address) !== -1)
          .reduce((prev, cur) => Math.max(prev, cur.index), 0) + 1;
      return doDiscovery(newN, deriveType, offset + n);
    };
    const highestReceiveIndex = await doDiscovery(threshold, 'receive', 0);
    const highestChangeIndex = await doDiscovery(threshold, 'change', 0);
    this.addressManager.receiveAddress.advance(highestReceiveIndex + 1);
    this.addressManager.changeAddress.advance(highestChangeIndex + 1);
    logger.log(
      'info',
      `receive address index: ${highestReceiveIndex}; change address index: ${highestChangeIndex}`
    );
    return this.updateUtxos(Object.keys(this.transactionsStorage));
  }

  // TODO: convert amount to sompis aka satoshis
  // TODO: bn
  /**
   * Compose a serialized, signed transaction
   * @param obj
   * @param obj.toAddr To address in cashaddr format (e.g. kaspatest:qq0d6h0prjm5mpdld5pncst3adu0yam6xch4tr69k2)
   * @param obj.amount Amount to send in sompis (100000000 (1e8) sompis in 1 KSP)
   * @param obj.fee Fee for miners in sompis
   * @param obj.changeAddrOverride Use this to override automatic change address derivation
   * @throws if amount is above `Number.MAX_SAFE_INTEGER`
   */
  composeTx({
    toAddr,
    amount,
    fee = DEFAULT_FEE,
    changeAddrOverride,
  }: TxSend & { changeAddrOverride?: string }): {
    id: string;
    rawTx: string;
    utxoIds: string[];
    amount: number;
  } {
    if (!Number.isSafeInteger(amount)) throw new Error('Amount too large');
    const { utxos, utxoIds } = this.utxoSet.selectUtxos(amount + fee);
    const privKeys = utxos.reduce((prev, cur) => {
      prev.push(this.addressManager.all[cur.address]);
      return prev;
    }, []);
    const changeAddr = changeAddrOverride || this.addressManager.changeAddress.next();
    const tx: bitcore.Transaction = new bitcore.Transaction()
      .from(utxos)
      .to(toAddr, amount)
      .setVersion(1)
      .fee(fee)
      .change(changeAddr)
      .sign(privKeys, bitcore.crypto.Signature.SIGHASH_ALL, 'schnorr');
    this.utxoSet.inUse.push(...utxoIds);
    this.pending.add(tx.id, { rawTx: tx.toString(), utxoIds, amount: amount + fee });
    this.utxoSet.updateUtxoBalance();
    this.updateBalance();
    this.receiveAddress = this.addressManager.receiveAddress.next();
    return { id: tx.id, rawTx: tx.toString(), utxoIds, amount: amount + fee };
  }

  /**
   * Send a transaction. Returns transaction id.
   * @param txParams
   * @param txParams.toAddr To address in cashaddr format (e.g. kaspatest:qq0d6h0prjm5mpdld5pncst3adu0yam6xch4tr69k2)
   * @param txParams.amount Amount to send in sompis (100000000 (1e8) sompis in 1 KSP)
   * @param txParams.fee Fee for miners in sompis
   * @throws `FetchError` if endpoint is down. API error message if tx error. Error if amount is too large to be represented as a javascript number.
   */
  async sendTx(txParams: TxSend): Promise<string> {
    const { id, rawTx } = this.composeTx(txParams);
    try {
      await api.postTx(rawTx);
    } catch (e) {
      this.deleteTx(id);
      throw e;
    }
    return id;
  }

  deleteTx(id: string): void {
    const { utxoIds } = this.pending.transactions[id];
    delete this.pending.transactions[id];
    this.utxoSet.release(utxoIds);
    this.utxoSet.updateUtxoBalance();
    this.updateBalance();
  }

  /**
   *  Converts a mnemonic to a new wallet.
   * @param seedPhrase The 12 word seed phrase.
   * @returns new Wallet
   */
  static fromMnemonic(seedPhrase: string): Wallet {
    const privKey = new Mnemonic(seedPhrase.trim()).toHDPrivateKey().toString();
    const wallet = new this(privKey, seedPhrase);
    return wallet;
  }

  /**
   * Creates a new Wallet from encrypted wallet data.
   * @param password the password the user encrypted their seed phrase with
   * @param encryptedMnemonic the encrypted seed phrase from local storage
   * @throws Will throw "Incorrect password" if password is wrong
   */
  static async import(password: string, encryptedMnemonic: string): Promise<Wallet> {
    const decrypted = await passworder.decrypt(password, encryptedMnemonic);
    const savedWallet = JSON.parse(Buffer.from(decrypted).toString('utf8')) as WalletSave;
    const myWallet = new this(savedWallet.privKey, savedWallet.seedPhrase);
    return myWallet;
  }

  /**
   * Generates encrypted wallet data.
   * @param password user's chosen password
   * @returns Promise that resolves to object-like string. Suggested to store as string for .import().
   */
  async export(password: string): Promise<string> {
    const savedWallet: WalletSave = {
      privKey: this.HDWallet.toString(),
      seedPhrase: this.mnemonic,
    };
    return passworder.encrypt(password, Buffer.from(JSON.stringify(savedWallet), 'utf8'));
  }
}

export default Wallet;
